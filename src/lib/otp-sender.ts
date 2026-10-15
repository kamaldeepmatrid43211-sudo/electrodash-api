import { config } from '../config.js';

export type OtpDelivery = { sent: true; devCode?: string };

/**
 * Sends the OTP. With `console` (development) and `test` (live server while the app is being
 * built) no SMS is sent: the code is logged and returned to the app, which fills it in.
 */
export async function sendOtp(phone: string, code: string, log: { info: (msg: string) => void }): Promise<OtpDelivery> {
  if (config.OTP_PROVIDER === 'console' || config.OTP_PROVIDER === 'test') {
    log.info(`[${config.OTP_PROVIDER} OTP] ${phone} → ${code}`);
    return { sent: true, devCode: code };
  }
  if (!config.MSG91_AUTH_KEY || !config.MSG91_TEMPLATE_ID) {
    throw new Error('MSG91 is not configured (MSG91_AUTH_KEY, MSG91_TEMPLATE_ID).');
  }
  const res = await fetch('https://control.msg91.com/api/v5/otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authkey: config.MSG91_AUTH_KEY },
    body: JSON.stringify({ template_id: config.MSG91_TEMPLATE_ID, mobile: `91${phone}`, otp: code }),
  });
  if (!res.ok) throw new Error(`SMS provider error (${res.status})`);
  return { sent: true };
}
