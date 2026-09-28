import type { z } from "zod";
import { RepositoryLocalizationSourceInputSchema } from "@corely/contracts";

export const repositoryLocalizationProviderKey =
  "patchctl.repository-localization";

export type RepositoryLocalizationSource = {
  id: string;
  tenantId: string;
  configuration: z.infer<typeof RepositoryLocalizationSourceInputSchema>;
};

export interface RepositoryLocalizationSourceRepository {
  provisionRepositoryLocalizationToken(input: {
    tenantId: string;
    ownerUserId: string;
    keyHash: string;
    sourceId: string;
    configuration: RepositoryLocalizationSource["configuration"];
  }): Promise<void>;
  findRepositoryLocalizationSource(
    tenantId: string,
    sourceId: string,
  ): Promise<RepositoryLocalizationSource | null>;
}
