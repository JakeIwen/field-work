import { useEffect, useRef, useState } from "react";
import {
  AnnotationMode,
  GlobalWorkerOptions,
  getDocument,
  TextLayer,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import InfoTooltip from "./InfoTooltip";
import {
  ArrowDownToLine,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  AlertTriangle,
} from "lucide-react";

GlobalWorkerOptions.workerSrc = workerUrl;

type Props = { src: string; title: string; downloadUrl?: string };

/** Rasterizes a local PDF and supplies a text layer. PDF scripts, actions,
 * annotations, forms, and embedded HTML are never instantiated by this viewer. */
export default function PdfViewer({ src, title, downloadUrl = src }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState("fit");
  const [width, setWidth] = useState(0);
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState("");
  const [textAvailable, setTextAvailable] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () =>
      setWidth(Math.max(140, Math.floor(element.clientWidth - 28)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    setDocument(null);
    setPage(1);
    setError("");
    setLoading(true);
    setTextAvailable(false);
    // Keep acquisition same-origin even if a future caller supplies an unsafe URL.
    const url = new URL(src, window.location.href);
    if (
      url.origin !== window.location.origin ||
      !url.pathname.startsWith("/api/")
    ) {
      setError("Only local application document URLs can be previewed.");
      setLoading(false);
      return;
    }
    const options = {
      url: url.href,
      enableXfa: false,
      // PDF.js 6 removed the older evaluator and isEvalSupported option.
      // The application CSP also excludes unsafe-eval.
      useWasm: false,
      useSystemFonts: true,
      disableAutoFetch: true,
      disableStream: true,
      maxImageSize: 20_000_000,
    };
    const task = getDocument(options);
    task.onPassword = () => {
      if (!disposed) {
        setError(
          "This PDF is password protected. Download it to open in your PDF reader.",
        );
        setLoading(false);
      }
      void task.destroy();
    };
    task.promise
      .then((pdf) => {
        if (!disposed) {
          setDocument(pdf);
          setLoading(false);
        }
      })
      .catch((reason) => {
        if (!disposed) {
          setError(reason?.message || "The PDF could not be loaded.");
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
      void task.destroy();
    };
  }, [src]);

  useEffect(() => {
    const parent = surface.current;
    if (!document || !width || !parent) return;
    let disposed = false;
    let renderTask: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    setRendering(true);
    setTextAvailable(false);
    setError("");
    // Each rendering owns separate nodes, so a canceled old render never writes
    // into a new page or React StrictMode's replacement render.
    const pageElement = window.document.createElement("div");
    pageElement.className = "pdf-page-surface";
    const canvas = window.document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    const textContainer = window.document.createElement("div");
    textContainer.className = "pdf-selectable-text";
    textContainer.setAttribute("role", "document");
    textContainer.setAttribute("aria-label", `${title}, page ${page}`);
    pageElement.append(canvas, textContainer);
    parent.replaceChildren(pageElement);

    document
      .getPage(page)
      .then(async (pdfPage) => {
        if (disposed) return;
        const natural = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({
          scale:
            zoom === "fit"
              ? Math.min(width, 1050) / natural.width
              : Number(zoom),
        });
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.ceil(viewport.width * pixelRatio);
        canvas.height = Math.ceil(viewport.height * pixelRatio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        pageElement.style.width = `${viewport.width}px`;
        pageElement.style.height = `${viewport.height}px`;
        pageElement.style.setProperty(
          "--total-scale-factor",
          String(viewport.scale),
        );
        renderTask = pdfPage.render({
          canvas,
          viewport,
          transform:
            pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
          annotationMode: AnnotationMode.DISABLE,
        });
        // Cleanup may cancel while text extraction is pending; consume that
        // cancellation immediately before joining both rendering promises below.
        void renderTask.promise.catch(() => {});
        const content = await pdfPage.getTextContent();
        if (disposed) return;
        textLayer = new TextLayer({
          textContentSource: content,
          container: textContainer,
          viewport,
        });
        await Promise.all([renderTask.promise, textLayer.render()]);
        if (!disposed) {
          setTextAvailable(
            content.items.some(
              (item) => "str" in item && item.str.trim().length > 0,
            ),
          );
          setRendering(false);
        }
      })
      .catch((reason) => {
        if (!disposed && reason?.name !== "RenderingCancelledException") {
          setError(reason?.message || "This PDF page could not be rendered.");
          setRendering(false);
        }
      });
    return () => {
      disposed = true;
      renderTask?.cancel();
      textLayer?.cancel();
      pageElement.remove();
    };
  }, [document, page, width, title, zoom]);

  return (
    <section
      className="local-pdf-viewer"
      aria-label={`${title} PDF preview`}
      ref={host}
    >
      <div className="pdf-toolbar">
        <div className="pdf-pagination">
          <button
            className="icon-button"
            aria-label="Previous PDF page"
            title="Previous PDF page"
            disabled={!document || page <= 1 || loading}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft size={17} />
          </button>
          <span aria-live="polite">
            {document ? `Page ${page} of ${document.numPages}` : "PDF preview"}
          </span>
          {textAvailable && (
            <InfoTooltip label="About PDF text selection">
              Select and copy text directly from the page.
            </InfoTooltip>
          )}
          <button
            className="icon-button"
            aria-label="Next PDF page"
            title="Next PDF page"
            disabled={!document || page >= document.numPages || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight size={17} />
          </button>
        </div>
        <select
          className="pdf-zoom"
          aria-label="PDF zoom"
          value={zoom}
          onChange={(e) => setZoom(e.target.value)}
        >
          <option value="fit">Fit width</option>
          <option value="1">100%</option>
          <option value="1.5">150%</option>
          <option value="2">200%</option>
        </select>
        <a className="text-button" href={downloadUrl} download>
          <ArrowDownToLine size={14} /> Download PDF
        </a>
      </div>
      {(loading || rendering) && (
        <div className="pdf-render-state" role="status">
          <LoaderCircle className="spin" size={16} />{" "}
          {loading ? "Loading local PDF…" : "Rendering page…"}
        </div>
      )}
      {error && (
        <div className="banner danger pdf-render-error" role="alert">
          <AlertTriangle size={17} />
          <span>
            {error}{" "}
            <a href={downloadUrl} download>
              Download the original PDF
            </a>
            .
          </span>
        </div>
      )}
      <div
        className="pdf-canvas-host"
        ref={surface}
        aria-busy={loading || rendering}
      />
      {!loading && !rendering && !error && !textAvailable && (
        <p className="pdf-text-note">This page has no extractable text.</p>
      )}
    </section>
  );
}
