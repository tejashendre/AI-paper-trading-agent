/** Browser-safe status text; no account, storage or strategy dependency. */
export function describeResearchCapture(rows:{asset?:string;status?:string;lastCapturedAt?:string}[]):string {
  const failed=rows.filter(row=>row.status==='CAPTURE_ERROR');
  const full=rows.some(row=>row.status==='STORAGE_LIMIT');
  const messages:string[]=[];
  if (failed.length) messages.push(failed.map(row=>`${row.asset||'Asset'} capture failed; last successful capture: ${row.lastCapturedAt||'none recorded'}.`).join(' '));
  if (full) messages.push('Storage limit reached; capture paused.');
  if (messages.length) return messages.join(' ');
  return rows.some(row=>row.status==='CAPTURED'||row.status==='UNCHANGED')?
    'Closed bars and periodic summaries, capped at 1 GiB by default.':'Waiting for the first successful research capture.';
}
