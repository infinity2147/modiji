import type { Metadata } from "next";

export const metadata: Metadata = { title: "CaseDesk" };

const QUEUE_COLUMNS = ["Case", "Customer", "Type", "Received", "Status"] as const;

/** CaseDesk, the synthetic back-office sandbox the expert works in (plan §8). Cases arrive in P1. */
export default function CaseDeskPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-slate-100 text-slate-900">
      <header className="flex h-12 items-center border-b border-slate-700 bg-slate-800 px-4">
        <h1 className="text-sm font-semibold tracking-wide text-white">CaseDesk</h1>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 p-4">
        <section aria-labelledby="queue-heading" className="rounded border border-slate-300 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
            <h2 id="queue-heading" className="text-sm font-semibold">
              Case queue
            </h2>
            <span className="text-xs text-slate-500">0 cases</span>
          </div>
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                {QUEUE_COLUMNS.map((column) => (
                  <th key={column} scope="col" className="px-4 py-2 font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={QUEUE_COLUMNS.length} className="px-4 py-12 text-center text-slate-500">
                  No cases loaded
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </main>
    </div>
  );
}
