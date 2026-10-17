/** Let the renderer finish reading the current XRFrame before ending its session. */
export async function endXRSessionAfterFrame(session: Pick<XRSession, 'end'>): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  await session.end();
}
