import { ModelLifecycleHttpApi } from "./model-lifecycle-http-api.mjs";
import { ModelLifecycleService } from "./model-lifecycle-service.mjs";
import { ModelReportService } from "./model-report-service.mjs";
import { PostgresModelLifecycleRepository } from "./postgres-model-lifecycle-repository.mjs";
import { PostgresModelReportCatalog } from "./postgres-model-report-catalog.mjs";
import { PostgresModelValidationRepository } from "./postgres-model-validation-repository.mjs";

export function createModelAdministration({
  database,
  evidenceReader = null,
  clock = () => new Date(),
  audit = async () => {},
}) {
  if (!database?.query || !database?.transaction) {
    throw new TypeError("model administration requires a PostgreSQL transactional adapter");
  }
  const validationRuns = new PostgresModelValidationRepository({ database });
  const lifecycleService = new ModelLifecycleService({
    repository: new PostgresModelLifecycleRepository({ database }),
    validationRuns,
    clock,
    audit,
  });
  const reportService = new ModelReportService({
    catalog: new PostgresModelReportCatalog({ database, evidenceReader }),
    clock,
  });
  return Object.freeze({
    lifecycleService,
    reportService,
    httpApi: new ModelLifecycleHttpApi({ service: lifecycleService, reportService }),
  });
}
