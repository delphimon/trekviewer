import * as THREE from 'three';
import { GeoBounds, GPXWaypoint } from '../gpx/TrackTypes';
import { geoToLocalMeters } from '../gpx/Coordinates';

export class DioramaBase {
  /**
   * Creates a museum-grade architectural pedestal base with compass rose and scale bar.
   */
  public static create(
    bounds: GeoBounds,
    baseY: number = -80,
    waypoints: GPXWaypoint[] = []
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

    // Beveled accent border (glowing cyan / gold edge trim)
    const trimGeo = new THREE.BoxGeometry(widthM + 44, 2, depthM + 44);
    const trimMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.6,
    });
    const trim = new THREE.Mesh(trimGeo, trimMat);
    trim.position.y = baseY;
    group.add(trim);

    // 3D Compass Rose (pointing True North, which is -Z)
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
          wp.ele || bounds.minEle,
          bounds.centerLat,
          bounds.centerLon,
          bounds.minEle
        );
        const marker = this.createWaypointPin(wp.name);
        marker.position.set(loc.x, loc.y + 10, loc.z);
        wpGroup.add(marker);
      }
      group.add(wpGroup);
    }

    return group;
  }

  private static createCompassRose(): THREE.Group {
    const compass = new THREE.Group();
    compass.name = 'CompassRose';

    // Outer ring
    const ringGeo = new THREE.RingGeometry(25, 28, 32);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x94a3b8,
      side: THREE.DoubleSide,
    });
    compass.add(new THREE.Mesh(ringGeo, ringMat));

    // North Needle (Red Arrow pointing -Z)
    const northGeo = new THREE.ConeGeometry(8, 35, 4);
    northGeo.rotateX(-Math.PI / 2); // Point along -Z
    const northMat = new THREE.MeshStandardMaterial({
      color: 0xef4444, // Vibrant Red
      emissive: 0x991b1b,
      emissiveIntensity: 0.6,
    });
    const north = new THREE.Mesh(northGeo, northMat);
    north.position.z = -18;
    compass.add(north);

    // South Needle (White/Silver Arrow pointing +Z)
    const southGeo = new THREE.ConeGeometry(8, 35, 4);
    southGeo.rotateX(Math.PI / 2); // Point along +Z
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
    const jewel = new THREE.Mesh(jewelGeo, jewelMat);
    compass.add(jewel);

    return compass;
  }

  private static createScaleBar(widthM: number): THREE.Group {
    const group = new THREE.Group();
    group.name = 'ScaleBar';

    // 1 km or 5 km bar depending on extent
    const barLength = widthM > 8000 ? 2000 : 1000;
    const barGeo = new THREE.BoxGeometry(barLength, 3, 8);
    const barMat = new THREE.MeshBasicMaterial({ color: 0xe2e8f0 });
    const bar = new THREE.Mesh(barGeo, barMat);
    bar.position.x = barLength / 2;
    group.add(bar);

    // End caps
    const capGeo = new THREE.BoxGeometry(4, 8, 16);
    const capMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
    const cap1 = new THREE.Mesh(capGeo, capMat);
    const cap2 = new THREE.Mesh(capGeo, capMat);
    cap2.position.x = barLength;
    group.add(cap1);
    group.add(cap2);

    return group;
  }

  private static createWaypointPin(name: string): THREE.Group {
    const pin = new THREE.Group();

    // 3D diamond waypoint
    const octGeo = new THREE.OctahedronGeometry(5, 0);
    const octMat = new THREE.MeshStandardMaterial({
      color: 0x3b82f6,
      emissive: 0x1d4ed8,
      emissiveIntensity: 0.7,
    });
    const diamond = new THREE.Mesh(octGeo, octMat);
    diamond.position.y = 8;
    pin.add(diamond);

    // Vertical stalk
    const stalkGeo = new THREE.CylinderGeometry(0.5, 0.5, 8, 8);
    const stalkMat = new THREE.MeshBasicMaterial({ color: 0x60a5fa });
    const stalk = new THREE.Mesh(stalkGeo, stalkMat);
    stalk.position.y = 4;
    pin.add(stalk);

    return pin;
  }
}
