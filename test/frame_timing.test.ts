import { expect, it } from 'vitest';
import { FrameTimingMonitor } from '../src/core/FrameTimingMonitor.ts';

it('reports callback pacing and CPU percentiles at the actual refresh rate',()=>{
  const monitor=new FrameTimingMonitor();
  for(let i=0;i<=144;i++)monitor.record(i*1000/72,3,'xr-high',72);
  const stats=monitor.snapshot();
  expect(stats.samples).toBe(144);expect(stats.averageFps).toBeCloseTo(72,8);
  expect(stats.intervalP95Ms).toBeCloseTo(1000/72,8);expect(stats.cpuP95Ms).toBe(3);
  expect(stats.estimatedMissedCallbacks).toBe(0);
});

it('keeps true long stalls and estimates missed callbacks without calling them GPU drops',()=>{
  const monitor=new FrameTimingMonitor();
  monitor.record(0,2,'xr',100);monitor.record(10,2,'xr',100);monitor.record(40,20,'xr',100);monitor.record(2040,1990,'xr',100);
  expect(monitor.snapshot()).toMatchObject({samples:3,intervalMaxMs:2000,cpuP95Ms:1990,estimatedMissedCallbacks:201});
});

it('bounds history and resets across view/profile/refresh changes and visibility pauses',()=>{
  const monitor=new FrameTimingMonitor(2);
  monitor.record(0,0,'xr',72);monitor.record(10,100,'xr',72);monitor.record(20,2,'xr',72);monitor.record(30,3,'xr',72);
  expect(monitor.snapshot()).toMatchObject({samples:2,cpuP95Ms:3});
  monitor.record(40,1,'desktop',null);expect(monitor.snapshot().samples).toBe(0);
  monitor.record(50,2,'desktop',null);expect(monitor.snapshot().estimatedMissedCallbacks).toBeNull();
  monitor.reset();monitor.record(9000,2,'desktop',null);expect(monitor.snapshot().samples).toBe(0);
  monitor.record(9010,2,'desktop',90);expect(monitor.snapshot()).toMatchObject({samples:0,targetHz:90});
});

it('rejects invalid samples and clock discontinuities',()=>{
  const monitor=new FrameTimingMonitor();
  monitor.record(NaN,1,'xr',72);monitor.record(10,1,'xr',72);monitor.record(20,-1,'xr',72);
  expect(monitor.snapshot().samples).toBe(0);
  monitor.record(10,1,'xr',72);monitor.record(5,1,'xr',72);monitor.record(15,1,'xr',72);
  expect(monitor.snapshot()).toMatchObject({samples:1,averageFps:100});
});
