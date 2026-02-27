const JUSTWATCH_GRAPHQL = 'https://apis.justwatch.com/graphql';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface StreamingOffer {
  monetizationType: string;
  presentationType: string;
  package: {
    clearName: string;
    /** Wird nicht mehr gesendet – Frontend baut Icon-URL aus clearName + /icons/{slug}.png */
    icon?: string;
  };
}

interface CacheEntry {
  offers: StreamingOffer[];
  expiresAt: number;
}

const cache = new Map<number, CacheEntry>();

/** Einheitlicher Anzeigename: nur "Netflix" bzw. "Amazon Prime", ohne "with Ads" / "Standard with Ads". */
function normalizeProviderDisplayName(clearName: string): string {
  if (!clearName?.trim()) return clearName;
  if (/^Netflix\b/i.test(clearName)) return 'Netflix';
  if (/^Amazon\s*Prime/i.test(clearName)) return 'Amazon Prime';
  return clearName;
}

interface SearchEdge {
  node: {
    id: string;
    content: {
      title: string;
      originalReleaseYear: number;
    };
  };
}

interface JustWatchSearchResult {
  data?: {
    searchTitles?: {
      edges: SearchEdge[];
    };
  };
}

interface JustWatchOffersResult {
  data?: {
    node?: {
      offers?: StreamingOffer[];
    } | null;
  };
}

async function graphqlRequest<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(JUSTWATCH_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`JustWatch request failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

async function findJustWatchNodeId(title: string, year: number): Promise<string | null> {
  try {
    // Country and Platform must be passed as inline GraphQL enum literals, not as variables,
    // because the JustWatch API does not expose its enum types for variable coercion.
    const query = `
      query SearchTitle($title: String!) {
        searchTitles(filter: { searchQuery: $title }, source: "TMDB", country: DE, language: de, first: 5) {
          edges {
            node {
              id
              content(country: DE, language: de) {
                title
                originalReleaseYear
              }
            }
          }
        }
      }
    `;

    const result = await graphqlRequest<JustWatchSearchResult>(query, { title });
    const edges = result.data?.searchTitles?.edges ?? [];

    for (const edge of edges) {
      if (edge.node.content.originalReleaseYear === year) {
        return edge.node.id;
      }
    }
    return edges[0]?.node.id ?? null;
  } catch {
    return null;
  }
}

export async function getStreamingOffers(
  movieId: number,
  title: string,
  releaseYear: number,
): Promise<StreamingOffer[]> {
  const now = Date.now();
  const cached = cache.get(movieId);
  if (cached && cached.expiresAt > now) {
    return cached.offers;
  }

  try {
    const nodeId = await findJustWatchNodeId(title, releaseYear);
    if (!nodeId) {
      cache.set(movieId, { offers: [], expiresAt: now + CACHE_TTL_MS });
      return [];
    }

    // Country and Platform are inline enums — they cannot be used as typed variables here
    const query = `
      query GetOffers($nodeId: ID!) {
        node(id: $nodeId) {
          ... on Movie {
            offers(country: DE, platform: WEB) {
              monetizationType
              presentationType
              package {
                clearName
                icon
              }
            }
          }
        }
      }
    `;

    const result = await graphqlRequest<JustWatchOffersResult>(query, { nodeId });
    const allOffers = result.data?.node?.offers ?? [];

    // Nur echte Streaming-Abos (flatrate) und kostenlose Angebote – keine Kinos, kein Kauf/Leihe (JPC, Thalia, Cinestar, UCI, Filmspiegel etc.)
    const STREAMING_MONETIZATION = new Set(['flatrate', 'free']);
    const filtered = allOffers.filter(
      (o) => STREAMING_MONETIZATION.has(o.monetizationType?.toLowerCase?.() ?? ''),
    );

    // Anzeigenamen vereinheitlichen. Icon-URL baut das Frontend aus clearName + /icons/{slug}.png.
    const offers = filtered.map((o) => ({
      ...o,
      package: {
        clearName: normalizeProviderDisplayName(o.package.clearName),
      },
    }));

    cache.set(movieId, { offers, expiresAt: now + CACHE_TTL_MS });
    return offers;
  } catch {
    cache.set(movieId, { offers: [], expiresAt: now + CACHE_TTL_MS });
    return [];
  }
}
