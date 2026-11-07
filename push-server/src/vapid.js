'use strict';

function createWebPushSender(config) {
  const publicKey = config.publicKey || '';
  const privateKey = config.privateKey || '';
  const subject = config.subject || '';
  const configured = !!(publicKey && privateKey && subject);
  let webpush = null;
  if (configured) {
    webpush = require('web-push');
    webpush.setVapidDetails(subject, publicKey, privateKey);
  }
  return {
    configured: configured,
    publicKey: publicKey,
    async send(subscription, payload) {
      if (!configured || !webpush) {
        const err = new Error('push_not_configured');
        err.statusCode = 503;
        throw err;
      }
      try {
        await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: subscription.keys },
          JSON.stringify(payload),
          { TTL: 12 * 60 * 60, urgency: 'high' }
        );
      } catch (err) {
        const wrapped = new Error('push_rejected');
        wrapped.statusCode = err && err.statusCode ? err.statusCode : 0;
        throw wrapped;
      }
    }
  };
}

function safeBootLog(config, host, port) {
  return {
    ok: true,
    host: host,
    port: port,
    configured: !!(config.publicKey && config.privateKey && config.subject && config.dispatchToken),
    realtime: false
  };
}

module.exports = { createWebPushSender, safeBootLog };
