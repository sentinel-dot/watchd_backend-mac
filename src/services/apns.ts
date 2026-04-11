import apn from '@parse/node-apn';
import { config } from '../config';
import { logger } from '../logger';

let provider: apn.Provider | null = null;

function getProvider(): apn.Provider | null {
  if (provider) return provider;

  const { keyId, teamId, key } = config.apns;
  if (!keyId || !teamId || !key) {
    logger.warn({ hasKeyId: !!keyId, hasTeamId: !!teamId, hasKey: !!key }, 'APNs provider not initialized — missing config');
    return null;
  }

  try {
    // Key is stored as base64 in the env var to avoid newline issues
    const keyBuffer = Buffer.from(key, 'base64');
    provider = new apn.Provider({
      token: {
        key: keyBuffer,
        keyId,
        teamId,
      },
      production: config.apns.production,
    });
    logger.info('APNs provider initialized');
    return provider;
  } catch (err) {
    logger.error({ err }, 'Failed to initialize APNs provider');
    return null;
  }
}

export async function sendMatchPush(deviceTokens: string[], movieTitle: string): Promise<void> {
  const prov = getProvider();
  if (!prov || deviceTokens.length === 0) return;

  const notification = new apn.Notification();
  notification.expiry = Math.floor(Date.now() / 1000) + 3600;
  notification.badge = 1;
  notification.sound = 'default';
  notification.alert = {
    title: 'Match! 🎬',
    body: `Ihr mögt beide "${movieTitle}"`,
  };
  notification.topic = 'com.milinkovic.watchd';
  notification.payload = { type: 'match', movieTitle };

  try {
    const result = await prov.send(notification, deviceTokens);
    if (result.failed.length > 0) {
      logger.warn({ failed: result.failed }, 'APNs: some tokens failed');
    }
    logger.info({ sent: result.sent.length, failed: result.failed.length }, 'APNs push sent');
  } catch (err) {
    logger.error({ err }, 'APNs send error');
  }
}
