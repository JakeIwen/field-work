import "./dev-badge.css";

/** Marks a hot-reload preview; the caller renders it only when
 * import.meta.env.DEV so production bundles drop it. */
export default function DevBadge() {
  return (
    <div
      className="dev-badge"
      title="Local hot-reload preview of the working tree, not production. The branch is the checkout this preview serves; the api port is the backend it talks to."
    >
      dev · :{location.port} · {__DEV_BRANCH__} · api :{__DEV_API_PORT__}
    </div>
  );
}
