# TrekViewer Stage X3.1 — Visual Corruption Emergency Stabilization Report

## 1. Executive Summary

Stage X3.1 successfully identifies and resolves the dual visual failure modes observed on Meta Quest 3 hardware and desktop environments:
1. **Gray-Blue Square Following Hiker**: Hiker-centered `LocalTerrainChunk` meshes were erroneously displayed in Tabletop / Diorama mode and lacked valid high-resolution elevation samples (collapsing to base elevation 0).
2. **Irregular Permanent Black Regions**: Two independent failure paths caused persistent black areas across the terrain:
   - **Shared Texture Backing Store Destruction**: Eviction of warm `LocalTerrainChunk` objects triggered `disposeObject3D()`, which traversed `material.map` (the shared base terrain texture) and destroyed its backing canvas dimensions (`canvas.width = 1; canvas.height = 1`) and GPU texture resources.
   - **Blank / Transparent Composite Canvas Cells**: Intermediate progressive satellite canvas streaming installed partially populated canvases with unrendered RGBA (0, 0, 0, 0) cells, and failed network tiles permanently preserved transparent black voids.

All 61 test suites (290 tests) now pass cleanly. In Tabletop / Diorama mode, base terrain is 100% authoritative and local geometry is hidden. In First-Person (1:1) mode, candidate local terrain chunks load offscreen, are sanity-validated for finite elevations and bounded deviations, and promote transactionally.

---

## 2. Detailed Root Cause Analysis & Failure Paths

### Failure Path 1: The Gray-Blue Square Around the Hiker
* **Mechanism**:
  - In Stage X1/X2/X3, `LocalTerrainStreamer` followed route progress in every view mode, including Tabletop / Diorama mode, setting Station 0 `mesh.visible = true`.
  - In `LocalTerrainChunk` (constructor and `updateElevationGrid`), if high-resolution DEM samples were absent or failed (`!sample.isValid`), code assigned `hLocal = 0`.
  - On a mountain where the base terrain is at +1500m to +3000m, setting `hLocal = 0` plunged vertices down into deep pits or created distorted planar squares with inverted normals and default/untextured materials.
* **Resolution**:
  - **Diorama Isolation**: Tabletop / Diorama mode enforces `mesh.visible = false` for all local chunks. The base terrain mesh is 100% authoritative.
  - **Graceful Elevation Fallback**: Missing or invalid DEM vertices sample directly from the authoritative base terrain elevation (`hBase`), eliminating pits, vertical tears, and zero-height collapses.

### Failure Path 2: Shared Base Texture Destruction on Chunk Eviction
* **Mechanism**:
  - `LocalTerrainChunk` referenced the base terrain texture `terrainMat.map` to provide visual continuity.
  - When the hiker moved or the streamer exceeded `maxChunks`, stale chunks were evicted via `chunk.dispose()`, which called `disposeObject3D(this.mesh)`.
  - `disposeObject3D` traversed all materials and executed:
    ```typescript
    canvas.width = 1;
    canvas.height = 1;
    texture.dispose();
    ```
  - This destroyed the GPU texture and wiped the backing canvas of the shared base terrain texture, causing irregular black rectangles across the mountain.
* **Resolution**:
  - In `LocalTerrainChunk.dispose()`, `this.material.map` is explicitly detached (`this.material.map = null`) and registered in a `preserveTextures` Set passed to `disposeObject3D(this.mesh, preserveTextures)`.
  - Base terrain retains exclusive lifecycle ownership of its textures.

### Failure Path 3: Partial CanvasTexture and Blank Cell Leaks
* **Mechanism**:
  - `TextureProvider.fetchSatelliteTexture` created a fresh, blank HTML canvas (`RGBA 0, 0, 0, 0`).
  - During progressive streaming, `onProgressUpdate` assigned this intermediate canvas to `terrainMat.map`.
  - Unloaded tiles displayed black/transparent gaps.
  - Network tile failures left those cells permanently empty/black.
* **Resolution**:
  - Composite canvases are pre-populated with complete fallback imagery (`topoTexture.image` or prior stable base texture) from millisecond 0:
    ```typescript
    if (fallbackImage) {
      ctx.drawImage(fallbackImage, 0, 0, width, height);
    }
    ```
  - Unloaded and failed tiles retain valid fallback pixels, ensuring 100% coverage at all times.

---

## 3. Transactional Promotion Architecture

All terrain refinement follows the core principle: **Existing valid rendering remains visible; replacements load offscreen, are validated, and promote atomically.**

```
[ Authoritative Base Terrain Visible ]
                  │
                  ▼ (User Enters First-Person Mode)
[ Async: Fetch High-Res Local Terrarium DEM ]
                  │
                  ▼
[ Validate DEM Grid Quality (Coverage >= 70%) ] ──(Fails)──► [ Discard DEM; Retain Base Surface ]
                  │ (Passes)
                  ▼
[ Build Candidate LocalTerrainChunk Offscreen ]
                  │
                  ▼
[ Validate Geometry (No NaNs, No Infs, Sane Diff) ] ──(Fails)──► [ Discard Candidate; Retain Base Surface ]
                  │ (Passes)
                  ▼
[ Atomically Swap: Show Candidate, Detach Old Chunk ]
```

---

## 4. Verification Suite Matrix

The new test suite in `test/stage_x3_1_stabilization.test.ts` exercises all failure conditions:

| Test ID | Requirement | Verification Condition | Status |
|---|---|---|---|
| **Test A** | Partial DEM Fallback | Missing DEM tiles use base elevation (`hBase`), never 0 | **PASS** |
| **Test B** | DEM Update Incomplete Grid | Updating chunk with invalid tile sections does not collapse vertices | **PASS** |
| **Test C** | Partial Satellite Canvas | Canvas pre-populated with fallback; unloaded cells never RGBA 0/0/0/0 | **PASS** |
| **Test D** | Satellite Tile Failure | Permanent tile failure retains fallback image; no black holes | **PASS** |
| **Test E** | Shared Texture Ownership | Evicting/disposing local chunk preserves base texture and 1024x1024 canvas | **PASS** |
| **Test F** | Tabletop Diorama Policy | In diorama mode, all local chunks are hidden; base terrain authoritative | **PASS** |
| **Test G** | First-Person Policy | Switching to 1:1 reveals validated station 0; switching to diorama hides it | **PASS** |
| **Test H** | DEM Quality Threshold | Rejects local DEM grids with `< 70%` valid tile ratio | **PASS** |

Full suite results: **61 test files passed, 290 tests passed, 0 failures.**

---

## 5. Quest Hardware Verification & Remaining Risks

### Quest Hardware Status:
- Tabletop Diorama $(0.00, 0.82, -0.80)\,\text{m}$ world-locked position strictly preserved.
- No local geometry chunk is created or shown in Tabletop mode, eliminating the gray square.
- Base terrain texture canvas is protected from eviction-induced disposal, eliminating black corruption.
- Real-time debug telemetry (`?debug=1`) reports `Local DEM: diorama (hidden)` in tabletop mode and `Local DEM: first-person (active)` in 1:1 mode.

### Remaining Risks & Mitigations:
- **Low-Bandwidth Mobile Network Glitches**: If AWS Terrarium DEM tiles timeout completely, the system smoothly falls back to the route base DEM grid without visual stutter.
- **Future Geometry LOD in Tabletop**: Gaze-driven or camera-distance tabletop geometry LOD must use offscreen candidate validation before promotion, preserving the Stage X3.1 transactional contract.
