// League Stats views: specified separately and not built yet. Approvals (and later
// /submit, /rebuild and the nickname sync) call this, so the views plug in here.
export async function rebuildViews(): Promise<void> {
  console.log('rebuildViews: League Stats views are not built yet; nothing to rebuild');
}
