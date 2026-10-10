import app from "./index.js";

function wrapState(state) {
  return {
    get: state.get.bind(state),
    put: async (key, value, options) => {
      // Cloudflare Workers KV Free allows 1,000 writes/day. The actual
      // reservation state and dedupe keys are always written immediately,
      // but the optional dashboard heartbeat is limited to five-minute marks.
      // This keeps the monitor comfortably inside the free write allowance.
      if (key === "status" && new Date().getUTCMinutes() % 5 !== 0) return;
      return state.put(key, value, options);
    },
  };
}

function wrappedEnv(env) {
  return { ...env, STATE: wrapState(env.STATE) };
}

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, wrappedEnv(env), ctx);
  },
  scheduled(event, env, ctx) {
    return app.scheduled(event, wrappedEnv(env), ctx);
  },
};
