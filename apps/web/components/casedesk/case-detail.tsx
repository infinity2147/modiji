import type { ReactNode } from "react";
import { Building2, FileText, Handshake, Landmark, ShieldAlert, Users, type LucideIcon } from "lucide-react";
import { NORTHSTAR_COUNTRY_RISK, type KycCase } from "@vashistha/core/domains/kyc";
import { formatEur, formatIsoDate, formatPct, formatRelationshipAge } from "@/lib/client/format";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { DOCUMENT_STATUS_LABELS, ENTITY_LABELS, SOURCE_OF_FUNDS_LABELS } from "./labels";
import { FlagPill, Pill, RiskPill, type Tone } from "./pills";

function Section({
  id,
  title,
  icon: Icon,
  className,
  children,
}: {
  id: string;
  title: string;
  icon: LucideIcon;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card size="sm" className={cn("gap-0 py-0 shadow-xs", className)} aria-labelledby={id} role="region">
      <CardHeader className="border-b py-2.5!">
        <h3 id={id} className="font-heading leading-snug flex items-center gap-2 text-[13px] font-semibold">
            <Icon aria-hidden className="size-3.5 text-muted-foreground" />
            {title}
          </h3>
      </CardHeader>
      <CardContent className="py-3">{children}</CardContent>
    </Card>
  );
}

function Fields({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-2 text-[13px]">{children}</dl>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium">{children}</dd>
    </>
  );
}

const SOF_TONE: Record<KycCase["funds"]["sourceOfFunds"], Tone> = {
  verified: "success",
  unverified: "warning",
  not_provided: "danger",
};
const DOC_TONE: Record<KycCase["documents"][number]["status"], Tone> = {
  received: "success",
  missing: "danger",
  expired: "warning",
};

/** The case file, in the sections a KYC reviewer reads it. Read-only: only the review panel edits. */
export function CaseDetail({ kycCase }: { kycCase: KycCase }) {
  const { customer, relationship, owners, screening, funds, documents } = kycCase;
  const tier = NORTHSTAR_COUNTRY_RISK[customer.country];
  return (
    <article aria-labelledby="case-title" className="grid gap-3">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <p className="font-mono text-xs text-muted-foreground">{kycCase.id}</p>
          <h2 id="case-title" className="text-lg leading-tight font-semibold tracking-tight">
            {customer.name}
          </h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Submitted <time dateTime={kycCase.submittedAt}>{formatIsoDate(kycCase.submittedAt)}</time>
        </p>
      </header>

      <div className="grid gap-3 xl:grid-cols-2">
        <Section id="sec-customer" title="Customer" icon={Building2}>
          <Fields>
            <Field label="Name">{customer.name}</Field>
            <Field label="Entity type">{ENTITY_LABELS[customer.entityType]}</Field>
            <Field label="Registration no.">
              <span className="font-mono text-xs">{customer.registrationNo}</span>
            </Field>
            <Field label="Country">
              <span className="flex flex-wrap items-center gap-2">
                {customer.country}
                <RiskPill tier={tier} />
              </span>
            </Field>
            <Field label="Address">
              <span className="font-normal">{customer.address}</span>
            </Field>
          </Fields>
        </Section>

        <Section id="sec-relationship" title="Relationship" icon={Handshake}>
          <Fields>
            <Field label="Customer status">
              <Pill tone={relationship.status === "new" ? "info" : "neutral"}>
                {relationship.status === "new" ? "New customer" : "Existing customer"}
              </Pill>
            </Field>
            <Field label="Relationship age">
              <span className="tabular-nums">{formatRelationshipAge(relationship.accountAgeMonths)}</span>
            </Field>
            <Field label="Relationship manager">{relationship.relationshipManager}</Field>
          </Fields>
        </Section>
      </div>

      <Section id="sec-owners" title="Beneficial owners" icon={Users}>
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-8 text-xs">Name</TableHead>
              <TableHead className="h-8 text-xs">Role</TableHead>
              <TableHead className="h-8 text-right text-xs">Share</TableHead>
              <TableHead className="h-8 text-xs">ID verified</TableHead>
              <TableHead className="h-8 text-xs">PEP</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {owners.map((owner) => (
              <TableRow key={`${owner.name}-${owner.role}`}>
                <TableCell className="py-1.5 font-medium">{owner.name}</TableCell>
                <TableCell className="py-1.5 text-muted-foreground">{owner.role}</TableCell>
                <TableCell className="py-1.5 text-right tabular-nums">{formatPct(owner.sharePct)}</TableCell>
                <TableCell className="py-1.5">
                  <Pill tone={owner.idVerified ? "success" : "warning"}>{owner.idVerified ? "Verified" : "Not verified"}</Pill>
                </TableCell>
                <TableCell className="py-1.5">
                  <FlagPill value={owner.pep} concernWhen />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <div className="grid gap-3 xl:grid-cols-2">
        <Section id="sec-screening" title="Screening" icon={ShieldAlert}>
          <Fields>
            <Field label="Sanctions">
              <span className="grid justify-items-start gap-1">
                <Pill tone={screening.sanctions.status === "match" ? "danger" : "success"}>
                  {screening.sanctions.status === "match" ? "Match" : "Clear"}
                </Pill>
                {screening.sanctions.detail && (
                  <span className="text-xs font-normal text-muted-foreground">{screening.sanctions.detail}</span>
                )}
              </span>
            </Field>
            <Field label="Adverse media">
              <span className="grid justify-items-start gap-1">
                <Pill tone={screening.adverseMedia.status === "found" ? "danger" : "success"}>
                  {screening.adverseMedia.status === "found" ? "Found" : "None"}
                </Pill>
                {screening.adverseMedia.detail && (
                  <span className="text-xs font-normal text-muted-foreground">{screening.adverseMedia.detail}</span>
                )}
              </span>
            </Field>
          </Fields>
        </Section>

        <Section id="sec-funds" title="Source of funds" icon={Landmark}>
          <Fields>
            <Field label="Status">
              <Pill tone={SOF_TONE[funds.sourceOfFunds]}>{SOURCE_OF_FUNDS_LABELS[funds.sourceOfFunds]}</Pill>
            </Field>
            <Field label="Description">
              <span className="font-normal">{funds.description || "—"}</span>
            </Field>
            <Field label="Expected monthly volume">
              <span className="tabular-nums">{formatEur(funds.expectedMonthlyVolumeEur)}</span>
            </Field>
          </Fields>
        </Section>
      </div>

      <Section id="sec-documents" title="Documents" icon={FileText}>
        {documents.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No documents on file.</p>
        ) : (
          <ul className="grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2">
            {documents.map((doc) => (
              <li key={doc.name} className="flex items-center justify-between gap-3 border-b border-dashed py-1 last:border-0">
                <span>{doc.name}</span>
                <Pill tone={DOC_TONE[doc.status]}>{DOCUMENT_STATUS_LABELS[doc.status]}</Pill>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </article>
  );
}
