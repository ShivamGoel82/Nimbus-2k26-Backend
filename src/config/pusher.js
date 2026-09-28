import Pusher from "pusher";

const hasPusherConfig = Boolean(
  process.env.PUSHER_APP_ID &&
  process.env.PUSHER_KEY &&
  process.env.PUSHER_SECRET
);

const realPusher = hasPusherConfig
  ? new Pusher({
      appId: process.env.PUSHER_APP_ID,
      key: process.env.PUSHER_KEY,
      secret: process.env.PUSHER_SECRET,
      cluster: process.env.PUSHER_CLUSTER || "ap2",
      useTLS: true,
    })
  : null;

const pusher = {
  trigger: async (channel, event, data) => {
    if (!realPusher) {
      // Graceful fallback when Pusher credentials are not provided locally
      return;
    }
    return realPusher.trigger(channel, event, data);
  },
  authenticate: (socketId, channel, data) => {
    if (!realPusher) return { auth: "mock_auth" };
    return realPusher.authenticate(socketId, channel, data);
  },
  authorizeChannel: (socketId, channel, data) => {
    if (!realPusher) return { auth: "mock_auth" };
    return realPusher.authorizeChannel(socketId, channel, data);
  },
};

export default pusher;
