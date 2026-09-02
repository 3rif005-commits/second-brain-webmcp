import Link from "next/link";

export default function BrainIndexPage() {
  return (
    <div className="flex-1 flex items-center justify-center px-8 bg-gray-50/30">
      <div className="text-center max-w-sm">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mx-auto mb-5 shadow-lg">
          <span className="text-3xl" aria-hidden="true">🧠</span>
        </div>
        <h2 className="text-2xl font-semibold text-gray-900 mb-2">
          Your Second Brain
        </h2>
        <p className="text-sm text-gray-500 mb-7 leading-relaxed">
          Capture ideas, import documents, and let AI help you understand
          everything you&apos;ve learned.
        </p>
        <div className="flex gap-3 justify-center">
          <Link
            href="/brain/new"
            className="inline-flex items-center gap-1.5 text-sm font-semibold px-5 py-2.5 rounded-xl border border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-500 hover:border-indigo-500 transition-colors shadow-sm"
          >
            + New Note
          </Link>
          <Link
            href="/brain/ingest"
            className="inline-flex items-center gap-1.5 text-sm font-semibold px-5 py-2.5 rounded-xl border border-gray-200 text-gray-700 hover:bg-gray-50 hover:border-gray-300 transition-colors"
          >
            Import
          </Link>
        </div>
      </div>
    </div>
  );
}
