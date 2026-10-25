import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { projects } from '@/lib/db/schema';
import { WorkspaceShell } from '@/components/workspace/shell';

export const dynamic = 'force-dynamic';

export default async function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const rows = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  if (rows.length === 0) notFound();

  // Catat "terakhir dibuka" di sini juga, bukan hanya saat diklik dari Home:
  // membuka lewat URL langsung/bookmark dulu membuat kartu selalu "Never opened".
  await db
    .update(projects)
    .set({ lastOpenedAt: new Date() })
    .where(eq(projects.slug, slug));

  return <WorkspaceShell slug={slug} projectName={rows[0].name} />;
}
