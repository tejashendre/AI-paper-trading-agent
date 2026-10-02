/** Browser-safe status text; no account, storage or strategy dependency. */
export function promotionProgress(metrics: { forwardPositions?: number; forwardSpanMs?: number;
  forwardRequiredPositions?: number; forwardRequiredSpanMs?: number; forwardExpectancy95?: { low: number } | null }) {
  const lower = metrics.forwardExpectancy95?.low;
  return `Forward path: ${metrics.forwardPositions ?? 0}/${metrics.forwardRequiredPositions ?? 30} independent positions; ` +
    `${((metrics.forwardSpanMs ?? 0) / 86400000).toFixed(1)}/${(metrics.forwardRequiredSpanMs ?? 14 * 86400000) / 86400000} days; ` +
    `95% lower mean net return: ${Number.isFinite(lower) ? (lower! * 100).toFixed(3) + '%' : 'unavailable'}. All fee, cost-stress, trial and risk checks must also pass.`;
}

export function describeResearchCapture(rows:{asset?:string;status?:string;lastCapturedAt?:string}[]):string {
  const failed=rows.filter(row=>row.status==='CAPTURE_ERROR');
  const full=rows.some(row=>row.status==='STORAGE_LIMIT');
  const messages:string[]=[];
  if (failed.length) messages.push(failed.map(row=>`${row.asset||'Asset'} capture failed; last successful capture: ${row.lastCapturedAt||'none recorded'}.`).join(' '));
  if (full) messages.push('Storage limit reached; capture paused.');
  if (messages.length) return messages.join(' ');
  return rows.some(row=>row.status==='CAPTURED'||row.status==='UNCHANGED')?
    'Closed bars and periodic summaries, capped at 256 MiB with oldest-day rotation.':'Waiting for the first successful research capture.';
}
