/**
 * Normalizes a phone number to E.164 ("+639171234567"), or returns null.
 *
 * Accepts local Philippine formats ("0917 123 4567", "917-123-4567",
 * "63 917 123 4567") and international numbers starting with + or 00.
 * Philippine numbers must be mobile numbers (+639…), since landlines can't
 * receive SMS.
 */
export function normalizePhone(input: string, defaultCountryCode = '63'): string | null {
  const s = input.trim().replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(s)) return null;
  let digits: string;
  if (s.startsWith('+')) digits = s.slice(1);
  else if (s.startsWith('00')) digits = s.slice(2);
  else if (s.startsWith('0')) digits = defaultCountryCode + s.slice(1);
  else if (s.startsWith(defaultCountryCode) && s.length > 10) digits = s;
  else if (defaultCountryCode === '63' && /^9\d{9}$/.test(s)) digits = `63${s}`;
  else return null;
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  if (digits.startsWith('63') && !/^639\d{9}$/.test(digits)) return null;
  return `+${digits}`;
}

/** "+639171234567" -> "+63917***4567" for logs. */
export function maskPhone(phone: string): string {
  return phone.length > 8 ? `${phone.slice(0, 6)}***${phone.slice(-4)}` : '***';
}

/** "maria@example.com" -> "m***@example.com" for logs. */
export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  return domain ? `${user.slice(0, 1)}***@${domain}` : '***';
}
