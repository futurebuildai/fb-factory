import { useActionQuery } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";

interface ConsoleHealthResult {
  environments: Array<{
    name: string;
    url: string;
    status: number | "error";
    healthy: boolean;
    detail: string;
  }>;
  checkedAt: string;
}

interface RuntimeInfoResult {
  app: string;
  node: string;
  uptimeSeconds: number;
  pid: number;
}

function StatusDot({ healthy }: { healthy: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-2.5 w-2.5 rounded-full ${
        healthy ? "bg-primary" : "bg-destructive"
      }`}
    />
  );
}

export default function Index() {
  const t = useT();
  const health = useActionQuery<ConsoleHealthResult>("console-health", {});
  const runtime = useActionQuery<RuntimeInfoResult>("runtime-info", {});

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("home.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("home.subtitle")}</p>
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">
          {t("home.consoleHealth")}
        </h2>
        {health.isLoading && (
          <p className="text-sm text-muted-foreground">{t("home.loading")}</p>
        )}
        {health.error && (
          <p className="text-sm text-destructive">{t("home.loadFailed")}</p>
        )}
        {health.data && (
          <ul className="flex flex-col gap-2">
            {health.data.environments.map((env) => (
              <li
                key={env.name}
                className="flex items-center gap-3 text-sm"
              >
                <StatusDot healthy={env.healthy} />
                <span className="w-24 font-medium">{env.name}</span>
                <a
                  href={env.url}
                  className="text-muted-foreground underline-offset-2 hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  {new URL(env.url).host}
                </a>
                <span className="ml-auto text-xs text-muted-foreground">
                  {env.detail}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">
          {t("home.runtime")}
        </h2>
        {runtime.data && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted-foreground">App</dt>
            <dd>{runtime.data.app}</dd>
            <dt className="text-muted-foreground">Node</dt>
            <dd>{runtime.data.node}</dd>
            <dt className="text-muted-foreground">Uptime</dt>
            <dd>{Math.floor(runtime.data.uptimeSeconds)}s</dd>
          </dl>
        )}
      </section>
    </div>
  );
}
