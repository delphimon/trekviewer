#!/usr/bin/env node
// Metadata-only source audit at each bundled route's highest recorded point.
// Identifies catalog contributors; it does not certify coverage of an entire
// route, browser CORS, native survey accuracy or actual rendered mesh resolution.
import fs from 'node:fs';
import path from 'node:path';
const out = path.resolve(process.env.TREK_SOURCE_AUDIT_OUT ?? '.review-cache/route-source-audit');
fs.mkdirSync(out, { recursive: true });
const services = {
  elevation: 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer',
  imagery: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer',
};
const mosaicRule = { mosaicMethod: 'esriMosaicAttribute', sortField: 'Best', sortValue: '0', ascending: true, mosaicOperation: 'MT_FIRST' };
const routes = JSON.parse(fs.readFileSync('public/routes/manifest.json', 'utf8'));
async function identify(service, point, kind) {
  const pixel = 1 / Math.cos(point.lat * Math.PI / 180);
  const params = new URLSearchParams({ f: 'json', geometry: JSON.stringify({ x: point.lon, y: point.lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint', pixelSize: JSON.stringify({ x: pixel, y: pixel, spatialReference: { wkid: 3857 } }),
    renderingRule: JSON.stringify({ rasterFunction: kind === 'elevation' ? 'None' : 'NaturalColor' }),
    returnCatalogItems: 'true', returnGeometry: 'false', maxItemCount: '30' });
  if (kind === 'elevation') params.set('mosaicRule', JSON.stringify(mosaicRule));
  const url = `${service}/identify?${params}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const data = await response.json(); if (data.error) throw Error(JSON.stringify(data.error));
    const catalog = (data.catalogItems?.features ?? []).map((feature, i) => {
      const a = feature.attributes, weight = data.catalogItemVisibilities?.[i] ?? null;
      return { id: a.OBJECTID, name: a.Name, title: a.title ?? null, contribution: weight,
        catalogLowPS: a.LowPS, catalogHighPS: a.HighPS, resolutionX: a.Resolution_X ?? null, resolutionY: a.Resolution_Y ?? null,
        nativeResolutionValue: a.resolution_value ?? null, nativeResolutionUnits: a.resolution_units ?? null,
        source: a.Source ?? a.agency ?? null, acquisitionDate: a.AcquisitionDate ?? a.acquisition_date ?? null, startDate: a.StartDate ?? null,
        endDate: a.EndDate ?? null, publication: a.pubdate ?? a.Year ?? null, sourceURL: a.URL ?? a.download_url ?? null };
    });
    return { service, url, retrieved: new Date().toISOString(), value: data.value ?? null,
      resultSpatialReference: data.location?.spatialReference ?? null, sampleValues: data.properties?.Values ?? [],
      reportedContributors: catalog.filter(item => item.contribution > 0), catalog,
      note: 'Catalog contribution is reported by identify; point metadata does not establish finest coverage or actual app source throughout the route.' };
  } catch (error) { return { service, url, retrieved: new Date().toISOString(), error: String(error) }; }
}
if (process.argv.includes('--fallback-imagery') || process.argv.includes('--refresh-imagery')) {
  const audit = JSON.parse(fs.readFileSync(path.join(out, 'audit.json'), 'utf8'));
  for (const route of audit.routes) {
    if (!route.imagery.error && !process.argv.includes('--refresh-imagery')) continue;
    if (route.imagery.error) route.preferredImageryFailure = route.imagery;
    const service = process.argv.includes('--refresh-imagery') && !route.imagery.error ? route.imagery.service
      : 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer';
    route.imagery = await identify(service, route.sample, 'imagery');
    fs.writeFileSync(path.join(out, 'audit.json'), JSON.stringify(audit, null, 2) + '\n');
    console.log(JSON.stringify({ route: route.id, fallbackImagery: route.imagery.reportedContributors?.map(c => ({ name: c.name, lowPS: c.catalogLowPS })) ?? route.imagery.error }));
  }
  process.exit();
}
const results = [], queue = [...routes];
await Promise.all(Array.from({ length: 2 }, async () => {
  while (queue.length) {
    const route = queue.shift(), xml = fs.readFileSync(path.join('public', route.file), 'utf8');
    const points = [...xml.matchAll(/<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g)].map(match => ({
      lat: Number(match[1].match(/\blat=["']([^"']+)["']/)?.[1]), lon: Number(match[1].match(/\blon=["']([^"']+)["']/)?.[1]),
      elevation: Number(match[2].match(/<ele>([^<]+)<\/ele>/)?.[1]),
    })).filter(p => [p.lat, p.lon, p.elevation].every(Number.isFinite));
    if (!points.length) throw Error(`No valid track points: ${route.file}`);
    const point = points.reduce((best, p) => p.elevation > best.elevation ? p : best);
    const result = { id: route.id, name: route.name, file: route.file, sample: point,
      bounds: points.reduce((b, p) => ({ minLat: Math.min(b.minLat, p.lat), maxLat: Math.max(b.maxLat, p.lat),
        minLon: Math.min(b.minLon, p.lon), maxLon: Math.max(b.maxLon, p.lon) }),
        { minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity }),
      elevation: await identify(services.elevation, point, 'elevation'), imagery: await identify(services.imagery, point, 'imagery') };
    results.push(result); fs.writeFileSync(path.join(out, 'audit.json'), JSON.stringify({ condition: 'Live metadata-only highest-point samples, not whole-route validation.', routes: results }, null, 2) + '\n');
    console.log(JSON.stringify({ route: route.id, elevation: result.elevation.reportedContributors?.map(c => ({ name: c.name, lowPS: c.catalogLowPS })) ?? result.elevation.error,
      imagery: result.imagery.reportedContributors?.map(c => ({ name: c.name, lowPS: c.catalogLowPS })) ?? result.imagery.error }));
  }
}));
