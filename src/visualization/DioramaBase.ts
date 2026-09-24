import * as THREE from 'three';
import { GeoBounds, GPXWaypoint } from '../gpx/TrackTypes';
import { geoToLocalMeters } from '../gpx/Coordinates';

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

    // Waypoint Markers
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
        const marker = this.createWaypointPin(wp);
        marker.userData = {
          waypoint: wp,
          baseY: baseYPos,
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

  private static createWaypointPin(wp: GPXWaypoint): THREE.Group {
    const pin = new THREE.Group();
    pin.name = `Waypoint_${wp.name}`;
    pin.userData = { waypoint: wp };

    const color =
      wp.type === 'summit'
        ? 0xf59e0b
        : wp.type === 'start'
        ? 0x10b981
        : wp.type === 'finish'
        ? 0xef4444
        : wp.type === 'day_boundary'
        ? 0x8b5cf6
        : 0x38bdf8;

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

    // Billboard Text Label for key waypoints (summits, trailheads, finish, camps)
    const label = this.createWaypointLabel(wp, color);
    if (label) {
      pin.add(label);
    }

    return pin;
  }

  private static createWaypointLabel(wp: GPXWaypoint, accentColor: number): THREE.Sprite | null {
    const isKeyLandmark = Boolean(
      wp.type === 'summit' ||
      wp.type === 'start' ||
      wp.type === 'finish' ||
      wp.type === 'day_boundary' ||
      wp.sym?.toLowerCase().includes('summit') ||
      wp.sym?.toLowerCase().includes('trailhead')
    );

    if (typeof document === 'undefined') return null;

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Dark glass pill background
    ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
    ctx.beginPath();
    if (typeof (ctx as any).roundRect === 'function') {
      (ctx as any).roundRect(8, 8, 240, 48, 12);
    } else if (typeof ctx.rect === 'function') {
      ctx.rect(8, 8, 240, 48);
    }
    ctx.fill();

    const hexStr = `#${accentColor.toString(16).padStart(6, '0')}`;
    ctx.strokeStyle = hexStr;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Text Label
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let text = wp.name;
    if (text.length > 18) text = text.substring(0, 16) + '...';
    ctx.fillText(text, 128, 32);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const spriteMat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(40, 10, 1);
    sprite.position.y = 24;
    sprite.visible = isKeyLandmark;
    // Explicitly disable raycasting on billboard sprites to prevent Three.js null-camera raycast exceptions
    sprite.raycast = () => {};
    return sprite;
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
