/* Public client settings only.
   No VAPID private key, dispatch token, webhook secret, or subscription.
   Leave apiBase empty until a push server exists. A phone can also save
   the server origin locally; that value never goes into this file. */
self.CHARLIE_PUSH_CONFIG = {
  apiBase: ""
};
