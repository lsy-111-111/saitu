export function DiscoveryFollowupStatus({ saving, saved, error, onRetry }: {
  saving: boolean; saved: boolean; error: string; onRetry: () => void;
}) {
  if (error) return <div className="rounded-xl bg-error-50 p-4 text-sm leading-7 text-error-700"><p role="alert">{error}</p><button type="button" className="mt-2 min-h-11 font-semibold underline" disabled={saving} onClick={onRetry}>重试保存补问</button></div>;
  if (saving) return <p className="text-xs leading-6 text-muted-foreground" role="status">正在保存补问…</p>;
  return saved ? <p className="text-xs leading-6 text-muted-foreground" role="status">补问已保存。</p> : null;
}
