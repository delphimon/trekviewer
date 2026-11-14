import { expect, it } from 'vitest';
import { landmarkLabelPriority, placeLandmarkLabels, type LabelRect } from '../src/visualization/DioramaBase.ts';

const rect = (priority: number, x: number, y = 0, visible = true): LabelRect => ({ priority, x, y, halfW: 0.1, halfH: 0.04, visible });

it('ranks summit, start, finish and day boundaries; other waypoints have no fixed label', () => {
  expect(['high_point', 'summit', 'start', 'finish', 'day_boundary', 'water', undefined].map(landmarkLabelPriority))
    .toEqual([0, 0, 1, 2, 3, null, null]);
});

it('hides a label that overlaps a higher-priority one and keeps separated labels', () => {
  const finish = rect(2, 0.05), start = rect(1, 0), summit = rect(0, 0.6), day = rect(3, -0.6);
  const rects = [finish, day, start, summit];
  placeLandmarkLabels(rects);
  expect([summit.visible, start.visible, finish.visible, day.visible]).toEqual([true, true, false, true]);
});

it('never lets an off-screen label hide another one', () => {
  const behind = rect(0, 0, 0, false), start = rect(1, 0);
  placeLandmarkLabels([behind, start]);
  expect(start.visible).toBe(true);
});
