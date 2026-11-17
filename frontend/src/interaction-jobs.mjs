// One paint per frame; every caller is settled, even during rapid selection.
export function createFrameBatcher(schedule, draw) {
  let queued = false;
  let waiters = [];
  return () => new Promise((resolve, reject) => {
    waiters.push({ resolve, reject });
    if (queued) return;
    queued = true;
    schedule(() => {
      queued = false;
      const current = waiters; waiters = [];
      try { draw(); current.forEach((w) => w.resolve()); }
      catch (err) { current.forEach((w) => w.reject(err)); }
    });
  });
}

// Visual navigation is independent from AI latency. Only a settled selection
// starts an AI call, and outdated responses never update the current panel.
export function createSelectionJobs({ link, analyze, show, failure, delay = 240 }) {
  let generation = 0;
  let timer;
  return {
    reset() { generation++; clearTimeout(timer); },
    select(node, options) {
      const epoch = ++generation;
      clearTimeout(timer);
      const stale = () => epoch !== generation;
      const visual = Promise.resolve().then(() => link(node, options, stale));
      timer = setTimeout(async () => {
        try { const result = await analyze(node.path); if (!stale()) show(node, result); }
        catch (err) { if (!stale()) failure(err); }
      }, delay);
      return visual;
    },
  };
}
