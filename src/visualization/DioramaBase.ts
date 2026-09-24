import * as THREE from 'three';
import { GeoBounds, GPXWaypoint } from '../gpx/TrackTypes';
import { geoToLocalMeters } from '../gpx/Coordinates';

const _scratchCamPos = new THREE.Vector3();
const _scratchLabelPos = new THREE.Vector3();

export class DioramaBase {
  /**
   * Creates a museum-grade architectural pedestal base with compass rose, scale bar, and waypoint markers.
   */
  public static create(
    bounds: GeoBounds,
    baseY: number = -80,
    waypoints: GPXWaypoint[] = [],
    baseElevation: number = bounds.minEle,
    elevationSampler?: (x: number, z: number) => number,
    initialExaggeration: number = 1.0
  ): THREE.Group {
    const group = new THREE.Group();
    group.name = 'DioramaBaseGroup';

    const margin = 0.25;
    const widthM = Math.max(bounds.widthMeters * (1 + margin * 2), 1500);
    const depthM = Math.max(bounds.depthMeters * (1 + margin * 2), 1500);
    const plinthHeight = 25; // meters in 1:1 scale

    // Main plinth slab
    const plinthGeo = new THREE.BoxGeometry(widthM + 40, plinthHeight, depthM + 40);
    const plinthMat = new THREE.MeshStandardMaterial({
      color: 0x111317, // Sleek matte obsidian / anodized titanium
      metalness: 0.8,
      roughness: 0.3,
    });
    const plinth = new THREE.Mesh(plinthGeo, plinthMat);
    plinth.position.y = baseY - plinthHeight / 2;
    plinth.receiveShadow = true;
    group.add(plinth);

    // Beveled accent border
    const trimGeo = new THREE.BoxGeometry(widthM + 44, 2, depthM + 44);
    const trimMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.6,
    });
    const trim = new THREE.Mesh(trimGeo, trimMat);
    trim.position.y = baseY;
    group.add(trim);

    // 3D Compass Rose (True North is -Z in Three.js)
    const compass = this.createCompassRose();
    compass.position.set(widthM / 2 + 60, baseY + 5, -depthM / 2 + 60);
    group.add(compass);

    // Scale Bar Indicator
    const scaleBar = this.createScaleBar(widthM);
    scaleBar.position.set(-widthM / 2 + 60, baseY + 2, depthM / 2 + 30);
    group.add(scaleBar);

    // Waypoint Markers (Sections 20-27)
    if (waypoints.length > 0) {
      const wpGroup = new THREE.Group();
      wpGroup.name = 'Waypoints';
      for (const wp of waypoints) {
        const loc = geoToLocalMeters(
          wp.lat,
          wp.lon,
          wp.ele ?? baseElevation,
          bounds.centerLat,
          bounds.centerLon,
          baseElevation
        );
        let baseYPos = loc.y;
        if (elevationSampler) {
          const sampleY = elevationSampler(loc.x, loc.z);
          if (!isNaN(sampleY)) {
            baseYPos = sampleY;
          }
        }
        const distanceMeters = (wp as any).distanceMeters;
        const marker = this.createWaypointPin(wp, distanceMeters);
        marker.userData = {
          waypoint: wp,
          baseY: baseYPos,
          hoverTimeout: 0,
          selectTimeout: 0,
          isHovered: false,
          isSelected: false,
        };
        marker.position.set(loc.x, baseYPos * initialExaggeration + 8, loc.z);
        wpGroup.add(marker);
      }
      group.add(wpGroup);
    }

    return group;
  }

  private static createCompassRose(): THREE.Group {
    const compass = new THREE.Group();
    compass.name = 'CompassRose';

    const ringGeo = new THREE.RingGeometry(25, 28, 32);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x94a3b8,
      side: THREE.DoubleSide,
    });
    compass.add(new THREE.Mesh(ringGeo, ringMat));

    // North Needle (-Z)
    const northGeo = new THREE.ConeGeometry(8, 35, 4);
    northGeo.rotateX(-Math.PI / 2);
    const northMat = new THREE.MeshStandardMaterial({
      color: 0xef4444,
      emissive: 0x991b1b,
      emissiveIntensity: 0.6,
    });
    const north = new THREE.Mesh(northGeo, northMat);
    north.position.z = -18;
    compass.add(north);

    // South Needle (+Z)
    const southGeo = new THREE.ConeGeometry(8, 35, 4);
    southGeo.rotateX(Math.PI / 2);
    const southMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      metalness: 0.8,
      roughness: 0.2,
    });
    const south = new THREE.Mesh(southGeo, southMat);
    south.position.z = 18;
    compass.add(south);

    // Center pivot jewel
    const jewelGeo = new THREE.CylinderGeometry(5, 5, 4, 16);
    const jewelMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      metalness: 0.9,
    });
    compass.add(new THREE.Mesh(jewelGeo, jewelMat));

    return compass;
  }

  private static createScaleBar(widthM: number): THREE.Group {
    const group = new THREE.Group();
    group.name = 'ScaleBar';

    const barLength = widthM > 8000 ? 2000 : 1000;
    const barGeo = new THREE.BoxGeometry(barLength, 3, 8);
    const barMat = new THREE.MeshBasicMaterial({ color: 0xe2e8f0 });
    const bar = new THREE.Mesh(barGeo, barMat);
    bar.position.x = barLength / 2;
    group.add(bar);

    const capGeo = new THREE.BoxGeometry(4, 8, 16);
    const capMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
    const cap1 = new THREE.Mesh(capGeo, capMat);
    const cap2 = new THREE.Mesh(capGeo, capMat);
    cap2.position.x = barLength;
    group.add(cap1);
    group.add(cap2);

    return group;
  }

  private static createWaypointPin(wp: GPXWaypoint, distanceMeters?: number): THREE.Group {
    const pin = new THREE.Group();
    pin.name = `Waypoint_${wp.name}`;
    pin.userData = {
      waypoint: wp,
      hoverTimeout: 0,
      selectTimeout: 0,
      isHovered: false,
      isSelected: false,
    };

    const color =
      wp.type === 'summit' || wp.type === 'high_point'
        ? 0xf59e0b
        : wp.type === 'start'
        ? 0x10b981
        : wp.type === 'finish'
        ? 0xef4444
        : wp.type === 'day_boundary'
        ? 0x8b5cf6
        : 0x38bdf8;

    // Visual Marker (Unobtrusive Diamond, Apparent Size ~2.2 cm) (Sections 21, 26)
    const octGeo = new THREE.OctahedronGeometry(6, 0);
    const octMat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.8,
      roughness: 0.2,
    });
    const diamond = new THREE.Mesh(octGeo, octMat);
    diamond.name = 'WaypointPinMesh';
    diamond.userData = { waypoint: wp };
    diamond.position.y = 12;
    pin.add(diamond);

    // Stalk
    const stalkGeo = new THREE.CylinderGeometry(0.8, 0.8, 12, 8);
    const stalkMat = new THREE.MeshBasicMaterial({ color: 0x94a3b8 });
    const stalk = new THREE.Mesh(stalkGeo, stalkMat);
    stalk.userData = { waypoint: wp };
    stalk.position.y = 6;
    pin.add(stalk);

    // Base ring
    const ringGeo = new THREE.RingGeometry(3, 7, 16);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.7,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.userData = { waypoint: wp };
    ring.position.y = 0.5;
    pin.add(ring);

    // Invisible Interaction Hit Target Sphere (~5 cm apparent diameter) (Section 26)
    const hitGeo = new THREE.SphereGeometry(24, 12, 12);
    const hitMat = new THREE.MeshBasicMaterial({
      visible: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const hitTarget = new THREE.Mesh(hitGeo, hitMat);
    hitTarget.name = 'WaypointHitTarget';
    hitTarget.position.y = 12;
    hitTarget.userData = { waypoint: wp, parentPin: pin };
    pin.add(hitTarget);

    // Billboard Text Label (Hidden by default, shown on hover/select) (Sections 22, 23, 24)
    const label = this.createWaypointLabel(wp, color, distanceMeters);
    if (label) {
      pin.add(label);
    }

    return pin;
  }

  private static createWaypointLabel(
    wp: GPXWaypoint,
    accentColor: number,
    distanceMeters?: number
  ): THREE.Sprite | null {
    if (typeof document === 'undefined') return null;

    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Dark glass pill background (Section 23)
    ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
    ctx.beginPath();
    if (typeof (ctx as any).roundRect === 'function') {
      (ctx as any).roundRect(8, 8, 368, 112, 16);
    } else {
      ctx.rect(8, 8, 368, 112);
    }
    ctx.fill();

    const hexStr = `#${accentColor.toString(16).padStart(6, '0')}`;
    ctx.strokeStyle = hexStr;
    ctx.lineWidth = 3;
    ctx.stroke();

    // Line 1: Waypoint name (Bold white)
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let nameText = wp.name;
    if (nameText.length > 22) nameText = nameText.substring(0, 20) + '…';
    ctx.fillText(nameText, 192, 42);

    // Line 2: Elevation & distance (Sections 23, 24)
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    const eleFt = wp.ele !== undefined ? Math.round(wp.ele * 3.28084) : null;
    const eleM = wp.ele !== undefined ? Math.round(wp.ele) : null;
    let detail = '';
    if (eleFt !== null) {
      detail += `${eleFt.toLocaleString()} ft (${eleM} m)`;
    }
    if (distanceMeters !== undefined && distanceMeters > 0) {
      const distMi = (distanceMeters * 0.000621371).toFixed(1);
      const distKm = (distanceMeters / 1000).toFixed(1);
      if (detail.length > 0) detail += ' • ';
      detail += `${distMi} mi (${distKm} km)`;
    }
    if (detail.length === 0) {
      detail = 'Landmark';
    }
    ctx.fillText(detail, 192, 84);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const spriteMat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.name = 'WaypointLabelSprite';
    // Hidden by default across all waypoints (Section 22)
    sprite.visible = false;
    sprite.position.y = 32;
    sprite.scale.set(40, 13.3, 1);
    // Explicitly disable raycasting on billboard sprites
    sprite.raycast = () => {};
    return sprite;
  }

  /**
   * Updates marker scale compensation and billboard label sizing/orientation each frame (Sections 21, 24, 25).
   */
  public static updateWaypoints(
    baseGroup: THREE.Group,
    camera: THREE.Camera,
    dioramaScale: number,
    delta: number
  ): void {
    const wpGroup = baseGroup.getObjectByName('Waypoints');
    if (!wpGroup || wpGroup.children.length === 0) return;

    // Target apparent world size: ~2.2 cm (0.022 m) across all tabletop zoom levels (Section 21)
    const safeScale = Math.max(dioramaScale, 1e-6);
    const targetMarkerScale = Math.max(0.001, Math.min(2.0, 0.022 / safeScale));

    const camWorldPos = _scratchCamPos;
    camera.getWorldPosition(camWorldPos);

    for (const child of wpGroup.children) {
      const pin = child as THREE.Group;
      pin.scale.setScalar(targetMarkerScale);

      const uData = pin.userData;
      if (uData.selectTimeout > 0) {
        uData.selectTimeout -= delta;
        if (uData.selectTimeout <= 0) {
          uData.isSelected = false;
        }
      }
      if (uData.hoverTimeout > 0) {
        uData.hoverTimeout -= delta;
        if (uData.hoverTimeout <= 0) {
          uData.isHovered = false;
        }
      }

      const label = pin.getObjectByName('WaypointLabelSprite') as THREE.Sprite | null;
      if (label) {
        const shouldBeVisible = Boolean(uData.isHovered || uData.isSelected);
        label.visible = shouldBeVisible;

        if (shouldBeVisible) {
          // Calculate readable angular size (8-14 deg horizontal FOV) (Section 24)
          const labelWorldPos = _scratchLabelPos;
          label.getWorldPosition(labelWorldPos);
          const distToCam = labelWorldPos.distanceTo(camWorldPos);
          const desiredWorldWidth = Math.max(0.08, Math.min(0.35, distToCam * 0.18));
          const desiredWorldHeight = desiredWorldWidth * (128 / 384);
          const netScale = safeScale * targetMarkerScale;
          label.scale.set(desiredWorldWidth / netScale, desiredWorldHeight / netScale, 1);
        }
      }
    }
  }

  /**
   * Activates hover label immediately (Section 27).
   */
  public static onHoverWaypoint(baseGroup: THREE.Group, pinOrTarget: THREE.Object3D): void {
    let pin: THREE.Object3D | null = pinOrTarget;
    while (pin && (!pin.userData || !pin.userData.waypoint)) {
      pin = pin.parent;
    }
    if (!pin) return;
    pin.userData.isHovered = true;
    pin.userData.hoverTimeout = 0;
    const label = pin.getObjectByName('WaypointLabelSprite');
    if (label) label.visible = true;
  }

  /**
   * Starts hover exit fade timer (Section 27).
   */
  public static onUnhoverWaypoint(baseGroup: THREE.Group): void {
    const wpGroup = baseGroup.getObjectByName('Waypoints');
    if (!wpGroup) return;
    for (const child of wpGroup.children) {
      if (child.userData.isHovered && child.userData.hoverTimeout <= 0) {
        child.userData.hoverTimeout = 0.8; // 0.8s fade timeout (Section 27)
      }
    }
  }

  /**
   * Selects a waypoint pin and shows label for 4.0 seconds (Section 27).
   */
  public static onSelectWaypoint(baseGroup: THREE.Group, pinOrTarget: THREE.Object3D): void {
    let pin: THREE.Object3D | null = pinOrTarget;
    while (pin && (!pin.userData || !pin.userData.waypoint)) {
      pin = pin.parent;
    }
    if (!pin) return;

    // Close any other active label selections (Section 27)
    const wpGroup = baseGroup.getObjectByName('Waypoints');
    if (wpGroup) {
      for (const child of wpGroup.children) {
        if (child !== pin) {
          child.userData.isSelected = false;
          child.userData.selectTimeout = 0;
          const lbl = child.getObjectByName('WaypointLabelSprite');
          if (lbl && !child.userData.isHovered) lbl.visible = false;
        }
      }
    }

    pin.userData.isSelected = true;
    pin.userData.selectTimeout = 4.0;
    const label = pin.getObjectByName('WaypointLabelSprite');
    if (label) label.visible = true;
  }

  /**
   * Selects and highlights a waypoint by name.
   */
  public static selectWaypointByName(baseGroup: THREE.Group, name: string): void {
    const wpGroup = baseGroup.getObjectByName('Waypoints');
    if (!wpGroup) return;
    const lower = name.toLowerCase().trim();
    for (const child of wpGroup.children) {
      const wp = child.userData?.waypoint as GPXWaypoint | undefined;
      if (wp && (wp.name.toLowerCase().trim() === lower || wp.name.toLowerCase().includes(lower))) {
        this.onSelectWaypoint(baseGroup, child);
        break;
      }
    }
  }

  /**
   * Adjusts waypoint pin vertical positions when vertical exaggeration changes.
   */
  public static setVerticalExaggeration(baseGroup: THREE.Group, factor: number): void {
    const wpGroup = baseGroup.getObjectByName('Waypoints');
    if (!wpGroup) return;
    for (const child of wpGroup.children) {
      if (child.userData && typeof child.userData.baseY === 'number') {
        child.position.y = child.userData.baseY * factor + 8;
      }
    }
  }
}
