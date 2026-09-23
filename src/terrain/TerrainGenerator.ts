import * as THREE from 'three';
import type { GeoBounds, TrackStats, TextureStyle } from '../gpx/TrackTypes.ts';
import { geoToLocalMeters, localMetersToGeo } from '../gpx/Coordinates.ts';
import { type ElevationGrid, ElevationTileService } from './ElevationTiles.ts';
import { TextureProvider } from './TextureProvider.ts';
import { TextureBudget } from './TextureBudget.ts';
import { disposeObject3D } from '../core/ResourceLifecycle.ts';

export type TerrainQuality = 'dem' | 'partial-dem' | 'synthetic';

export interface TerrainResult {
  group: THREE.Group;
  terrainMesh: THREE.Mesh;
  skirtMesh: THREE.Mesh;
  bounds: GeoBounds;
  terrainBaseElevation: number;
  terrainQuality: TerrainQuality;
  demGrid: ElevationGrid | null;
  elevationSampler: (x: number, z: number) => number;
  setTextureStyle: (style: TextureStyle) => Promise<void>;
  setVerticalExaggeration: (factor: number) => void;
  dispose: () => void;
}

export class TerrainGenerator {
  /**
   * Generates a complete 3D real-world terrain model with side diorama skirts.
   * Preserves authentic DEM topography without clamping valleys below track minimum
   * or distorting mountain shapes.
   */
  public static async generate(
    track: TrackStats,
    onProgress?: (msg: string, progress?: number | null) => void,
    signal?: AbortSignal,
    initialExaggeration: number = 1.0,
    isXR: boolean = false
  ): Promise<TerrainResult> {
    onProgress?.('Fetching real-world 3D elevation data...', 0.1);

    const bounds = track.bounds;
    const centerLat = bounds.centerLat;
    const centerLon = bounds.centerLon;

    // Geometry dimensions (with 25% margin around the trek)
    const margin = 0.25;
    const widthM = Math.max(bounds.widthMeters * (1 + margin * 2), 1500);
    const depthM = Math.max(bounds.depthMeters * (1 + margin * 2), 1500);
    const maxExtent = Math.max(widthM, depthM);

    // Compute geographic bounds of the entire 3D plane mesh
    const nwGeo = localMetersToGeo(-widthM / 2, -depthM / 2, centerLat, centerLon);
    const seGeo = localMetersToGeo(widthM / 2, depthM / 2, centerLat, centerLon);
    const terrainGeoBounds: GeoBounds = {
      minLat: Math.min(nwGeo.lat, seGeo.lat),
      maxLat: Math.max(nwGeo.lat, seGeo.lat),
      minLon: Math.min(nwGeo.lon, seGeo.lon),
      maxLon: Math.max(nwGeo.lon, seGeo.lon),
      centerLat,
      centerLon,
      minEle: bounds.minEle,
      maxEle: bounds.maxEle,
      widthMeters: widthM,
      depthMeters: depthM,
      elevationSpan: bounds.elevationSpan,
    };

    // Shared tile grid covering the entire 3D mesh
    const tileGrid = TextureProvider.getTileGridForBounds(terrainGeoBounds, 0.05);

    // Fetch real DEM elevation tiles with cancellation support
    const demGrid = await ElevationTileService.fetchElevationGrid(
      terrainGeoBounds,
      0.05,
      (loaded, total) => {
        const pct = Math.round((loaded / total) * 45);
        onProgress?.(`Downloading 3D elevation tiles (${loaded}/${total})...`, 0.1 + pct / 100);
      },
      signal
    );

    if (signal?.aborted) {
      throw new Error('Terrain generation aborted');
    }

    // Determine terrain quality and base elevation
    let terrainQuality: TerrainQuality = 'dem';
    let terrainBaseElevation = bounds.minEle;

    if (demGrid) {
      const validRatio = demGrid.tileValidity.reduce((sum, v) => sum + v, 0) / demGrid.tileValidity.length;
      if (validRatio < 0.3) {
        terrainQuality = 'synthetic';
      } else if (validRatio < 0.99) {
        terrainQuality = 'partial-dem';
      } else {
        terrainQuality = 'dem';
      }

      // Base elevation is independent from the lowest track elevation (preserves valleys below track)
      terrainBaseElevation = Math.min(demGrid.minElevation, bounds.minEle) - 30;
      onProgress?.(terrainQuality === 'dem' ? 'Real-world DEM elevation loaded.' : 'Partial DEM elevation loaded (blending with survey).', 0.55);
    } else {
      terrainQuality = 'synthetic';
      terrainBaseElevation = bounds.minEle - 30;
      onProgress?.('Synthesizing alpine topography from GPS survey...', 0.55);
    }

    // Adaptive resolution based on terrain physical extent and device
    const { segX, segZ } = TextureBudget.getTerrainMeshResolution(maxExtent, isXR);

    const planeGeo = new THREE.PlaneGeometry(widthM, depthM, segX, segZ);
    planeGeo.rotateX(-Math.PI / 2);

    const posAttr = planeGeo.attributes.position;
    const uvAttr = planeGeo.attributes.uv;
    const vertexCount = posAttr.count;

    // Spatial hash for synthetic fallback when DEM is missing or tile failed
    const trackLocalPoints = track.points.map((p) => {
      const loc = geoToLocalMeters(p.lat, p.lon, p.ele, centerLat, centerLon, terrainBaseElevation);
      return { x: loc.x, y: loc.y, z: loc.z, ele: p.ele };
    });

    const CELL_SIZE = 200;
    const gridBuckets = new Map<string, { x: number; y: number; z: number; ele: number }[]>();
    for (let i = 0; i < trackLocalPoints.length; i += 2) {
      const pt = trackLocalPoints[i];
      const cx = Math.floor(pt.x / CELL_SIZE);
      const cz = Math.floor(pt.z / CELL_SIZE);
      const key = `${cx},${cz}`;
      let b = gridBuckets.get(key);
      if (!b) {
        b = [];
        gridBuckets.set(key, b);
      }
      b.push(pt);
    }

    const findNearestTrailElevation = (localX: number, localZ: number, maxDist: number) => {
      const cx = Math.floor(localX / CELL_SIZE);
      const cz = Math.floor(localZ / CELL_SIZE);
      let nearestD = maxDist;
      let nearestE: number | null = null;

      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = gridBuckets.get(`${cx + dx},${cz + dz}`);
          if (!bucket) continue;
          for (let k = 0; k < bucket.length; k++) {
            const pt = bucket[k];
            const d = Math.hypot(localX - pt.x, localZ - pt.z);
            if (d < nearestD) {
              nearestD = d;
              nearestE = pt.ele;
            }
          }
        }
      }
      return { dist: nearestD, ele: nearestE };
    };

    // Elevation sampling function
    const sampleHeightAt = (localX: number, localZ: number): number => {
      const geo = localMetersToGeo(localX, localZ, centerLat, centerLon);

      if (demGrid) {
        const sample = ElevationTileService.sampleElevation(demGrid, geo.lat, geo.lon);
        if (sample.isValid && !isNaN(sample.elevation)) {
          // Unclamped true DEM elevation relative to base
          return sample.elevation - terrainBaseElevation;
        }
      }

      // Fallback synthetic mountain shape guided by track survey
      const near = findNearestTrailElevation(localX, localZ, 1200);
      const trailEle = near.ele ?? track.minElevation;
      const ridgeFalloff = Math.max(0, 1 - near.dist / (widthM * 0.45));
      const valleySlope = Math.pow(ridgeFalloff, 1.4);

      const freq1 = 0.0015;
      const freq2 = 0.005;
      const crags =
        Math.sin(localX * freq1) * Math.cos(localZ * freq1) * 60 +
        Math.sin(localX * freq2 + localZ * freq2) * 20;

      const ele = track.minElevation + (trailEle - track.minElevation) * valleySlope + crags * valleySlope;
      return Math.max(ele - terrainBaseElevation, 0);
    };

    // Array storing unscaled height for vertical exaggeration
    const unscaledHeights = new Float32Array(vertexCount);

    // Apply heights and UVs with async chunking
    let currentExaggeration = initialExaggeration;
    const chunkSize = 4096;
    for (let i = 0; i < vertexCount; i += chunkSize) {
      if (signal?.aborted) throw new Error('Aborted');
      const end = Math.min(i + chunkSize, vertexCount);
      for (let j = i; j < end; j++) {
        const vx = posAttr.getX(j);
        const vz = posAttr.getZ(j);
        const h = sampleHeightAt(vx, vz);
        unscaledHeights[j] = h;
        posAttr.setY(j, h * currentExaggeration);

        const geo = localMetersToGeo(vx, vz, centerLat, centerLon);
        const uv = TextureProvider.getUVForGeo(geo.lat, geo.lon, tileGrid);
        uvAttr.setXY(j, uv.u, uv.v);
      }
      onProgress?.('Building 3D mountain mesh...', 0.6 + (end / vertexCount) * 0.2);
      await new Promise((r) => setTimeout(r, 0));
    }

    posAttr.needsUpdate = true;
    uvAttr.needsUpdate = true;
    planeGeo.computeVertexNormals();

    // Procedural Fallback Topo Texture for instant interactivity
    onProgress?.('Generating topographic texture...', 0.85);
    const topoTexture = TextureProvider.generateTopoTexture(
      bounds,
      tileGrid,
      (lat: number, lon: number) => {
        if (demGrid) {
          const sample = ElevationTileService.sampleElevation(demGrid, lat, lon);
          if (sample.isValid) return sample.elevation;
        }
        const loc = geoToLocalMeters(lat, lon, 0, centerLat, centerLon, 0);
        return sampleHeightAt(loc.x, loc.z) + terrainBaseElevation;
      },
      1024,
      1024
    );

    const terrainMat = new THREE.MeshStandardMaterial({
      map: topoTexture,
      roughness: 0.85,
      metalness: 0.1,
      flatShading: false,
    });

    const terrainMesh = new THREE.Mesh(planeGeo, terrainMat);
    terrainMesh.castShadow = true;
    terrainMesh.receiveShadow = true;

    // Diorama Skirts dropping down to pedestal
    const skirtBaseY = -80;
    let skirtGeo = this.createDioramaSkirts(planeGeo, segX, segZ, skirtBaseY);
    const skirtMat = new THREE.MeshStandardMaterial({
      color: 0x181a1f,
      roughness: 0.9,
      metalness: 0.2,
      side: THREE.DoubleSide,
    });
    const skirtMesh = new THREE.Mesh(skirtGeo, skirtMat);
    skirtMesh.receiveShadow = true;

    const group = new THREE.Group();
    group.name = 'TerrainGroup';
    group.add(terrainMesh);
    group.add(skirtMesh);

    // Satellite texture cache references
    let satelliteTexture: THREE.CanvasTexture | null = null;
    let highResTopoTexture: THREE.CanvasTexture | null = null;
    let hybridTexture: THREE.CanvasTexture | null = null;

    let currentActiveStyle: TextureStyle = 'satellite';
    let textureRequestGeneration: number = 0;
    let isDisposed: boolean = false;

    // Background streaming of satellite imagery
    TextureProvider.fetchSatelliteTexture(
      tileGrid,
      (tex, loaded, total) => {
        if (isDisposed || signal?.aborted || currentActiveStyle !== 'satellite') return;
        if (!satelliteTexture) {
          satelliteTexture = tex;
          terrainMat.map = tex;
          terrainMat.needsUpdate = true;
        }
        onProgress?.('Terrain ready — refining imagery…', loaded / total);
      },
      signal,
      isXR
    ).then((satTex) => {
      if (isDisposed || signal?.aborted || !satTex) return;
      satelliteTexture = satTex;
      if (currentActiveStyle === 'satellite') {
        terrainMat.map = satTex;
        terrainMat.needsUpdate = true;
        onProgress?.('Satellite imagery ready.', 1.0);
      }
    }).catch(() => {
      // Procedural topo remains active
    });

    const setTextureStyle = async (style: TextureStyle): Promise<void> => {
      if (isDisposed) return;
      currentActiveStyle = style;
      const gen = ++textureRequestGeneration;

      if (style === 'satellite') {
        if (!satelliteTexture) {
          onProgress?.('Fetching high-resolution satellite imagery...', null);
          const tex = await TextureProvider.fetchSatelliteTexture(
            tileGrid,
            (partialTex) => {
              if (isDisposed || signal?.aborted || gen !== textureRequestGeneration || currentActiveStyle !== 'satellite') return;
              terrainMat.map = partialTex;
              terrainMat.needsUpdate = true;
            },
            signal,
            isXR
          );
          if (!isDisposed && !signal?.aborted && tex) {
            satelliteTexture = tex;
          }
        }
        if (!isDisposed && !signal?.aborted && gen === textureRequestGeneration && currentActiveStyle === 'satellite') {
          if (satelliteTexture) {
            terrainMat.map = satelliteTexture;
            terrainMat.needsUpdate = true;
          }
        }
      } else if (style === 'hybrid') {
        if (!hybridTexture) {
          onProgress?.('Fetching hybrid satellite & label imagery...', null);
          const tex = await TextureProvider.fetchHybridTexture(
            tileGrid,
            (partialTex) => {
              if (isDisposed || signal?.aborted || gen !== textureRequestGeneration || currentActiveStyle !== 'hybrid') return;
              terrainMat.map = partialTex;
              terrainMat.needsUpdate = true;
            },
            signal,
            isXR
          );
          if (!isDisposed && !signal?.aborted && tex) {
            hybridTexture = tex;
          }
        }
        if (!isDisposed && !signal?.aborted && gen === textureRequestGeneration && currentActiveStyle === 'hybrid') {
          if (hybridTexture) {
            terrainMat.map = hybridTexture;
            terrainMat.needsUpdate = true;
          } else if (satelliteTexture) {
            terrainMat.map = satelliteTexture;
            terrainMat.needsUpdate = true;
          }
        }
      } else {
        if (!highResTopoTexture) {
          onProgress?.('Fetching USGS topographic map tiles...', null);
          const tex = await TextureProvider.fetchTopoTexture(
            tileGrid,
            (partialTex) => {
              if (isDisposed || signal?.aborted || gen !== textureRequestGeneration || currentActiveStyle !== style) return;
              terrainMat.map = partialTex;
              terrainMat.needsUpdate = true;
            },
            signal,
            isXR
          );
          if (!isDisposed && !signal?.aborted && tex) {
            highResTopoTexture = tex;
          }
        }
        if (!isDisposed && !signal?.aborted && gen === textureRequestGeneration && currentActiveStyle === style) {
          terrainMat.map = highResTopoTexture || topoTexture;
          terrainMat.needsUpdate = true;
        }
      }
    };

    const setVerticalExaggeration = (factor: number) => {
      currentExaggeration = Math.max(1.0, Math.min(3.0, factor));
      for (let i = 0; i < vertexCount; i++) {
        posAttr.setY(i, unscaledHeights[i] * currentExaggeration);
      }
      posAttr.needsUpdate = true;
      planeGeo.computeVertexNormals();

      // Recreate skirt geometry for new exaggeration
      skirtMesh.geometry.dispose();
      skirtGeo = TerrainGenerator.createDioramaSkirts(planeGeo, segX, segZ, skirtBaseY);
      skirtMesh.geometry = skirtGeo;
    };

    const dispose = () => {
      if (isDisposed) return;
      isDisposed = true;
      textureRequestGeneration++;
      disposeObject3D(group);
      satelliteTexture?.dispose();
      hybridTexture?.dispose();
      highResTopoTexture?.dispose();
      topoTexture.dispose();
    };

    return {
      group,
      terrainMesh,
      skirtMesh,
      bounds,
      terrainBaseElevation,
      terrainQuality,
      demGrid,
      elevationSampler: sampleHeightAt,
      setTextureStyle,
      setVerticalExaggeration,
      dispose,
    };
  }

  private static createDioramaSkirts(
    planeGeo: THREE.PlaneGeometry,
    segX: number,
    segZ: number,
    baseY: number
  ): THREE.BufferGeometry {
    const pos = planeGeo.attributes.position;
    const skirtPositions: number[] = [];
    const skirtNormals: number[] = [];
    const skirtIndices: number[] = [];

    const perimeterIndices: number[] = [];

    // North edge
    for (let x = 0; x <= segX; x++) perimeterIndices.push(x);
    // East edge
    for (let z = 1; z <= segZ; z++) perimeterIndices.push(z * (segX + 1) + segX);
    // South edge
    for (let x = segX - 1; x >= 0; x--) perimeterIndices.push(segZ * (segX + 1) + x);
    // West edge
    for (let z = segZ - 1; z >= 1; z--) perimeterIndices.push(z * (segX + 1));

    let vertexOffset = 0;
    for (let i = 0; i < perimeterIndices.length; i++) {
      const curIdx = perimeterIndices[i];
      const nextIdx = perimeterIndices[(i + 1) % perimeterIndices.length];

      const x0 = pos.getX(curIdx);
      const y0 = pos.getY(curIdx);
      const z0 = pos.getZ(curIdx);

      const x1 = pos.getX(nextIdx);
      const y1 = pos.getY(nextIdx);
      const z1 = pos.getZ(nextIdx);

      skirtPositions.push(x0, y0, z0);
      skirtPositions.push(x1, y1, z1);
      skirtPositions.push(x1, baseY, z1);
      skirtPositions.push(x0, baseY, z0);

      const dx = x1 - x0;
      const dz = z1 - z0;
      const nx = -dz;
      const nz = dx;
      const len = Math.hypot(nx, nz) || 1;
      const unx = nx / len;
      const unz = nz / len;

      for (let k = 0; k < 4; k++) {
        skirtNormals.push(unx, 0, unz);
      }

      skirtIndices.push(
        vertexOffset,
        vertexOffset + 1,
        vertexOffset + 2,
        vertexOffset,
        vertexOffset + 2,
        vertexOffset + 3
      );

      vertexOffset += 4;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(skirtPositions, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(skirtNormals, 3));
    geom.setIndex(skirtIndices);
    return geom;
  }
}
