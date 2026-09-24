export interface ImageryProvider {
  readonly id: string;
  readonly displayName: string;
  readonly attribution: string;
  readonly maxZoom: number;
  getTileUrls(zoom: number, x: number, y: number): string[];
}

export class EsriWorldImageryProvider implements ImageryProvider {
  readonly id = 'esri-satellite';
  readonly displayName = 'Esri World Imagery';
  readonly attribution = 'Imagery: Esri, Maxar, Earthstar Geographics, USDA, USGS';
  readonly maxZoom = 19;

  getTileUrls(zoom: number, x: number, y: number): string[] {
    return [
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${y}/${x}`,
      `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${y}/${x}`,
    ];
  }
}

export class CesiumBingImageryProvider implements ImageryProvider {
  readonly id = 'cesium-bing';
  readonly displayName = 'Bing Aerial (Cesium Ion)';
  readonly attribution = 'Imagery: Microsoft Bing Maps, Cesium Ion';
  readonly maxZoom = 19;
  private token: string;
  private metadataPromise: Promise<{ urlTemplate: string; subdomains: string[] } | null> | null = null;
  private metadata: { urlTemplate: string; subdomains: string[] } | null = null;

  constructor(token: string) {
    this.token = token;
  }

  public async init(): Promise<boolean> {
    if (this.metadata) return true;
    if (!this.metadataPromise) {
      this.metadataPromise = (async () => {
        try {
          const res = await fetch(`https://api.cesium.com/v1/assets/2/endpoint?access_token=${this.token}`);
          if (!res.ok) return null;
          const data = await res.json();
          const bingKey = data.options?.key;
          if (!bingKey) return null;

          const metaRes = await fetch(`https://dev.virtualearth.net/REST/V1/Imagery/Metadata/Aerial?key=${bingKey}`);
          if (!metaRes.ok) return null;
          const metaData = await metaRes.json();
          const resource = metaData.resourceSets?.[0]?.resources?.[0];
          if (!resource) return null;

          let tmpl = (resource.imageUrl as string).replace('http://', 'https://');
          const subdomains = (resource.imageUrlSubdomains as string[]) || ['t0', 't1', 't2', 't3'];
          this.metadata = { urlTemplate: tmpl, subdomains };
          return this.metadata;
        } catch {
          return null;
        }
      })();
    }
    const meta = await this.metadataPromise;
    return meta !== null;
  }

  private tileXYToQuadKey(tileX: number, tileY: number, levelOfDetail: number): string {
    let quadKey = '';
    for (let i = levelOfDetail; i > 0; i--) {
      let digit = 0;
      const mask = 1 << (i - 1);
      if ((tileX & mask) !== 0) digit++;
      if ((tileY & mask) !== 0) digit += 2;
      quadKey += digit.toString();
    }
    return quadKey;
  }

  getTileUrls(zoom: number, x: number, y: number): string[] {
    const urls: string[] = [];
    if (this.metadata) {
      const qk = this.tileXYToQuadKey(x, y, zoom);
      const sub = this.metadata.subdomains[(x + y) % this.metadata.subdomains.length];
      urls.push(this.metadata.urlTemplate.replace('{subdomain}', sub).replace('{quadkey}', qk));
    }
    return urls;
  }
}

export class USGSTopoProvider implements ImageryProvider {
  readonly id = 'usgs-topo';
  readonly displayName = 'USGS Topographic Map';
  readonly attribution = 'Topo: USGS The National Map (USGSTopo)';
  readonly maxZoom = 16;

  getTileUrls(zoom: number, x: number, y: number): string[] {
    const otmSub = ['a', 'b', 'c'][(x + y) % 3];
    return [
      `https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/${zoom}/${y}/${x}`,
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/${zoom}/${y}/${x}`,
      `https://${otmSub}.tile.opentopomap.org/${zoom}/${x}/${y}.png`,
    ];
  }
}

export class EsriReferenceOverlayProvider implements ImageryProvider {
  readonly id = 'esri-labels';
  readonly displayName = 'World Reference Overlay';
  readonly attribution = 'Labels: Esri, Garmin, METI/NASA, USGS';
  readonly maxZoom = 19;

  getTileUrls(zoom: number, x: number, y: number): string[] {
    return [
      `https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Reference_Overlay/MapServer/tile/${zoom}/${y}/${x}`,
      `https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${zoom}/${y}/${x}`,
      `https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/${zoom}/${y}/${x}`,
    ];
  }
}

export class AWSTerrariumElevationProvider implements ImageryProvider {
  readonly id = 'aws-terrarium';
  readonly displayName = 'AWS Terrarium DEM';
  readonly attribution = 'Elevation: AWS Open Data (Mapzen Terrarium / SRTM)';
  readonly maxZoom = 15;

  getTileUrls(zoom: number, x: number, y: number): string[] {
    return [
      `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${x}/${y}.png`,
    ];
  }
}
