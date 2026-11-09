import React from "react";
import { LoaderCircle } from "lucide-react";


const LazyPdfPreview = React.lazy(() => import("./PdfViewer"));
export function PdfPreview(props: {
  src: string;
  title: string;
  downloadUrl?: string;
}) {
  return (
    <React.Suspense
      fallback={
        <div className="pdf-render-state" role="status">
          <LoaderCircle size={16} className="spin" /> Loading local PDF viewer…
        </div>
      }
    >
      <LazyPdfPreview {...props} />
    </React.Suspense>
  );
}
