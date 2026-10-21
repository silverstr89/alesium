// en-CA formats a date as YYYY-MM-DD. The time zone database supplies Nicosia's summer time (UTC+3).
const NICOSIA_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Nicosia', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The trading day of an instant, "YYYY-MM-DD". Days start at 00:00 in Nicosia (UTC+2 in winter, UTC+3 in summer). */
export function tradingDay(at: Date): string {
  return NICOSIA_DATE.format(at);
}
