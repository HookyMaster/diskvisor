export function createTreeStore(fetchChildren, key) {
  const nodes = new Map();
  const loaded = new Set();
  const pending = new Map();
  let generation = 0;
  function register(node) {
    const id = key(node.path);
    const existing = nodes.get(id);
    const canonical = existing || node;
    if (existing) {
      const { children, ...metadata } = node;
      Object.assign(existing, metadata);
    }
    nodes.set(id, canonical);
    if (Array.isArray(node.children) && !loaded.has(id)) {
      canonical.children = node.children.map(register);
      loaded.add(id);
    }
    return canonical;
  }
  return {
    get: (path) => nodes.get(key(path)),
    reset(root) {
      generation++;
      nodes.clear(); loaded.clear(); pending.clear();
      return root ? register(root) : null;
    },
    load(node) {
      const id = key(node.path);
      const canonical = nodes.get(id) || register(node);
      if (!canonical.is_dir || loaded.has(id)) return Promise.resolve(canonical.children || []);
      if (pending.has(id)) return pending.get(id);
      const epoch = generation;
      const request = Promise.resolve().then(() => fetchChildren(canonical.path)).then((children) => {
        if (epoch !== generation) throw new Error("scan superseded");
        canonical.children = children.map(register);
        loaded.add(id);
        return canonical.children;
      }).finally(() => { if (pending.get(id) === request) pending.delete(id); });
      pending.set(id, request);
      return request;
    },
  };
}
