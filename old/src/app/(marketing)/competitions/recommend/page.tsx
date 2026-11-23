import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CompetitionDiscoveryWizard } from "@/components/competitions/discovery/CompetitionDiscoveryWizard";
import { seo } from "@/content/seo";
import { isCompetitionRecommenderEnabled } from "@/lib/config/features";
import { createMetadata } from "@/lib/seo/metadata";
import { getCompetitionCatalog } from "@/lib/competitions/catalog";

export const metadata: Metadata = createMetadata(seo.pages.competitionRecommend);
export const dynamic = "force-dynamic";

export default function CompetitionRecommendationPage() {
  if (!isCompetitionRecommenderEnabled()) {
    notFound();
  }

  return (
    <main className="min-h-[calc(100vh-4rem)] bg-white pb-16">
      <section className="px-5 pb-12 pt-5 md:pb-20 md:pt-8">
        <div className="mx-auto w-full max-w-[1516px]">
          <CompetitionDiscoveryWizard detailLinks={getCompetitionCatalog().map(({ id }) => ({ id, path: `/competitions/${id}` }))} />
        </div>
      </section>
    </main>
  );
}
