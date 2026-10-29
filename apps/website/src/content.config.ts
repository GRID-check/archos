import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { CATEGORY_IDS } from './lib/categories';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    draft: z.boolean().default(false),
    // Required, no default: a post without one would land in no strand.
    category: z.enum(CATEGORY_IDS),
    // The other locale's slug, for hreflang and the language switch.
    translationSlug: z.string().optional(),
  }),
});

export const collections = { blog };
