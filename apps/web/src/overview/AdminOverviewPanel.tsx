import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { OperationsOverview } from "../device/AppliancePanel";
import { loadApplianceDashboard, type OperationsDashboard } from "../device/appliance-client";

export function AdminOverviewPanel({ t }: { t: (key: string) => string }) {
  const [dashboard, setDashboard] = useState<OperationsDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setDashboard(await loadApplianceDashboard());
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <section className="admin-overview-dashboard" aria-label={t("admin.overview.name")}>
      {failed && (
        <div className="admin-overview-state admin-overview-state--error" role="alert">
          <AlertTriangle size={17} aria-hidden="true" />
          <span>{t("admin.overview.error")}</span>
          <button type="button" onClick={() => void refresh()}>
            <RefreshCw size={14} aria-hidden="true" />{t("admin.overview.refresh")}
          </button>
        </div>
      )}
      {loading && dashboard === null ? (
        <div className="admin-overview-state" role="status" aria-live="polite" aria-busy="true">
          <LoaderCircle className="auth-spinner" size={20} aria-hidden="true" />
          {t("admin.overview.loading")}
        </div>
      ) : dashboard ? <OperationsOverview dashboard={dashboard} t={t} /> : null}
    </section>
  );
}
