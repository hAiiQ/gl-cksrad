export const GUILD_IDS = ['744595661889994852', '1384141435988738048'];

export class DiscordError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export function createDiscordClient(config, fetchImpl = fetch) {
  async function request(path, options) {
    const response = await fetchImpl(`https://discord.com/api/v10${path}`, {
      ...options, signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new DiscordError('Discord ist gerade nicht erreichbar. Bitte erneut versuchen.', response.status);
    return response.json();
  }
  function token(parameters) {
    return request('/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...parameters }),
    });
  }
  return {
    exchange: (code) => token({ grant_type: 'authorization_code', code, redirect_uri: config.callbackUrl }),
    refresh: (refreshToken) => token({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    user: (accessToken) => request('/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } }),
    guilds: (accessToken) => request('/users/@me/guilds?limit=200', { headers: { Authorization: `Bearer ${accessToken}` } }),
  };
}

export function publicUser(user) {
  const avatar = user.avatar && /^[a-zA-Z0-9_]+$/.test(user.avatar)
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : null;
  return { id: user.id, name: (user.global_name || user.username || 'Discord-Mitglied').slice(0, 80), avatar };
}
