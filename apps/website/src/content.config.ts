import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { CATEGORY_IDS } from './lib/categories';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/blog' }),
  schema: z.object({
    // A soft hyphen (\u00AD in a double-quoted title) marks where a long compound may break in
    // the heading; it is kept in `heading` and stripped from `title`, which feeds <title>, JSON-LD and the feed.
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    draft: z.boolean().default(false),
    // Required, no default: a post without one would land in no strand.
    category: z.enum(CATEGORY_IDS),
    // The other locale's slug, for hreflang and the language switch.
    translationSlug: z.string().optional(),
  }).transform((data) => ({ ...data, heading: data.title, title: data.title.replaceAll('­', '') })),
});

export const collections = { blog };
