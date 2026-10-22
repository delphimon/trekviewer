import { expect, it } from 'vitest';
import { offlineSourceIdentity, sameOfflineSource } from '../src/offline/OfflineSourceIdentity.ts';
import { archiveRequestProvenance } from '../src/offline/OfflineArchive.ts';
const make = (south: string) => 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?bbox=-13547950.402958488%2C'
  + south + '%2C-13546956.33033472%2C5919266.14406156&bboxSR=3857&imageSR=3857&size=679%2C679&compressionTolerance=0';

it('gives PC/browser final-ULP projection differences the same archive identity', () => {
  const pc = make('5918272.071436257'), browser = make('5918272.071436258');
  expect(offlineSourceIdentity(pc)).toBe(offlineSourceIdentity(browser));
  expect(sameOfflineSource(pc, [browser])).toBe(true);
  expect(pc).toContain('5918272.071436257'); expect(browser).toContain('5918272.071436258');
});

it('rejects changed extents, dimensions, projection, error tolerance and service', () => {
  const url = make('5918272.071436257');
  for (const changed of [make('5918272.081436257'), url.replace('679%2C679', '678%2C679'), url.replace('bboxSR=3857', 'bboxSR=4326'),
    url.replace('compressionTolerance=0', 'compressionTolerance=1'), url.replace('3DEPElevation', 'OtherElevation')]) {
    expect(sameOfflineSource(changed, [url])).toBe(false);
  }
});

it('leaves imagery identities exact and records the original DEM coordinates/request hash', async () => {
  const url = make('5918272.071436257'), image = url.replace('elevation.nationalmap.gov', 'imagery.nationalmap.gov').replace('3DEPElevation', 'USGSNAIPPlus');
  expect(offlineSourceIdentity(image)).toBe(image);
  const provenance = await archiveRequestProvenance(url);
  expect(provenance.sourceBounds?.[1]).toBe(5918272.071436257);
  expect(provenance.sourceRequestSha256).not.toBe((await archiveRequestProvenance(make('5918272.071436258'))).sourceRequestSha256);
});
