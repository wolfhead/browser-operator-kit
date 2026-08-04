export function buildFrameOffsets(observations) {
  const frames = new Map();
  for (const observation of observations) {
    if (!frames.has(observation.frameId)) frames.set(observation.frameId, observation);
  }
  const offsets = new Map([[0, { x: 0, y: 0 }]]);
  const usedLinks = new Set();
  for (let pass = 0; pass < frames.size; pass += 1) {
    let changed = false;
    for (const [frameId, frame] of frames) {
      if (offsets.has(frameId)) continue;
      for (const [parentFrameId, parentOffset] of offsets) {
        const parent = frames.get(parentFrameId);
        const links = (parent?.childFrames || []).filter((link, index) =>
          link.visible !== false && urlsMatch(link.src, frame.url) && !usedLinks.has(`${parentFrameId}:${index}`)
        );
        if (links.length === 0) continue;
        const link = links[0];
        const linkIndex = (parent.childFrames || []).indexOf(link);
        usedLinks.add(`${parentFrameId}:${linkIndex}`);
        offsets.set(frameId, {
          x: parentOffset.x + Number(link.contentX || 0),
          y: parentOffset.y + Number(link.contentY || 0)
        });
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return offsets;
}

export function chooseBestTarget(targets) {
  return [...targets].sort((left, right) => targetScore(right) - targetScore(left))[0] ?? null;
}

export function chooseBestScrollableTarget(targets) {
  return [...targets].sort((left, right) => {
    const scrollDifference = Number(right?.maximumScrollTop || 0) - Number(left?.maximumScrollTop || 0);
    return scrollDifference || targetScore(right) - targetScore(left);
  })[0] ?? null;
}

function targetScore(target) {
  return (target?.found ? 100 : 0) +
    (target?.coordinateReady ? 20 : 0) +
    (target?.visible ? 10 : 0) +
    (target?.enabled ? 4 : 0) +
    (target?.frameId === 0 ? 2 : 0) -
    (target?.occluded ? 8 : 0);
}

function urlsMatch(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.origin === rightUrl.origin && leftUrl.pathname === rightUrl.pathname && leftUrl.search === rightUrl.search;
  } catch {
    return false;
  }
}
