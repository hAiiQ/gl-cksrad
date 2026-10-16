export const TWITCH_CHANNEL = 'joedom';
export const TWITCH_SCOPE = 'user:read:follows';

export class TwitchError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export function createTwitchClient(config, fetchImpl = fetch) {
  let broadcaster;
  async function request(url, options = {}) {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new TwitchError('Twitch ist gerade nicht erreichbar. Bitte erneut versuchen.', response.status);
    return response.json();
  }
  function token(parameters) {
    return request('https://id.twitch.tv/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.twitchClientId, client_secret: config.twitchClientSecret, ...parameters }),
    });
  }
  function helix(path, accessToken) {
    return request(`https://api.twitch.tv/helix${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': config.twitchClientId },
    });
  }
  return {
    exchange: (code) => token({ grant_type: 'authorization_code', code, redirect_uri: config.twitchCallbackUrl }),
    refresh: (refreshToken) => token({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    validate: (accessToken) => request('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${accessToken}` } }),
    async follows(accessToken, userId) {
      if (!broadcaster || Date.now() > broadcaster.expiresAt) {
        const result = await helix(`/users?login=${TWITCH_CHANNEL}`, accessToken);
        const channel = result.data?.find((user) => user.login?.toLowerCase() === TWITCH_CHANNEL);
        if (!channel) throw new TwitchError('Der Twitch-Kanal konnte nicht geprüft werden. Bitte erneut versuchen.', 503);
        broadcaster = { id: channel.id, expiresAt: Date.now() + 3_600_000 };
      }
      const params = new URLSearchParams({ user_id: userId, broadcaster_id: broadcaster.id, first: '1' });
      const result = await helix(`/channels/followed?${params}`, accessToken);
      if (!Array.isArray(result.data)) throw new TwitchError('Ungültige Antwort von Twitch. Bitte erneut versuchen.', 503);
      return result.data.some((follow) => follow.broadcaster_id === broadcaster.id);
    },
  };
}
