import { config } from '../config.js';

export type OtpDelivery = { sent: true; devCode?: string };

/** Whether codes are shown in the app instead of sent by SMS: OTP_PROVIDER console/test, or the testLogin setting. */
export function isTestLogin(testLoginSetting: boolean): boolean {
  return config.OTP_PROVIDER !== 'msg91' || testLoginSetting;
}

/**
 * Sends the OTP. In test login (see isTestLogin) no SMS is sent: the code is logged and
 * returned to the app, which fills it in.
 */
export async function sendOtp(phone: string, code: string, log: { info: (msg: string) => void }, testLoginSetting = false): Promise<OtpDelivery> {
  if (isTestLogin(testLoginSetting)) {
    log.info(`[test OTP] ${phone} → ${code}`);
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
