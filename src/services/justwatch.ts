const JUSTWATCH_GRAPHQL = 'https://apis.justwatch.com/graphql';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Canonical provider display name → icon filename in public/icons
const PROVIDER_ICONS: Record<string, string> = {
  'Netflix': 'netflix.png',
  'Prime Video': 'amazon-prime.png',
  'Disney Plus': 'disney-plus.png',
  'Apple TV+': 'apple-tv.png',
  'HBO Max': 'hbo-max.png',
  'Joyn': 'joyn.png',
  'Paramount+': 'paramount-plus.png',
  'Rakuten TV': 'rakuten-tv.png',
  'RTL+': 'rtl-plus.png',
  'WOW': 'wow.png',
  'Magenta TV': 'magenta-tv.png',
  'Sky Go': 'sky-go.png',
};

export interface StreamingOffer {
  monetizationType: string;
  presentationType: string;
  package: {
    clearName: string;
    /**
     * Statischer Icon-Pfad, der vom Backend aus den Dateien in public/icons erzeugt wird,
     * z.B. /icons/netflix.png. Kann im Frontend direkt als <img src> genutzt werden.
     */
    iconPath?: string;
    icon?: string;
  };
}

interface CacheEntry {
  offers: StreamingOffer[];
  expiresAt: number;
}

const cache = new Map<number, CacheEntry>();

/** Einheitlicher Anzeigename: z. B. "Netflix", "Prime Video", ohne "with Ads" / "Standard with Ads". */
function normalizeProviderDisplayName(clearName: string): string {
  if (!clearName?.trim()) return clearName;
  if (/^Netflix\b/i.test(clearName)) return 'Netflix';
  // Amazon Prime / Prime Video / Prime → einheitlich als "Prime Video" anzeigen.
  if (/^Amazon\s*Prime\b/i.test(clearName)) return 'Prime Video';
  if (/^Prime\s*Video\b/i.test(clearName) || /^Prime\b/i.test(clearName)) return 'Prime Video';
  // Alle Channels, die über Amazon laufen (z.B. "HBO Max Amazon Channel"), als "Prime Video".
  if (/\bAmazon\b/i.test(clearName)) return 'Prime Video';
  if (/^Disney\b/i.test(clearName)) return 'Disney Plus';
  if (/^Apple\s*TV\b/i.test(clearName)) return 'Apple TV+';
  if (/^(HBO\s*Max|Max)\b/i.test(clearName)) return 'HBO Max';
  if (/^Joyn\b/i.test(clearName)) return 'Joyn';
  if (/^Paramount\b/i.test(clearName)) return 'Paramount+';
  if (/^Rakuten\s*TV\b/i.test(clearName)) return 'Rakuten TV';
  if (/^RTL\s*\+?/i.test(clearName)) return 'RTL+';
  if (/^WOW\b/i.test(clearName)) return 'WOW';
  if (/^Magenta\s*TV\b/i.test(clearName)) return 'Magenta TV';
  if (/^Sky\s*Go\b/i.test(clearName)) return 'Sky Go';
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

    // Anzeigenamen vereinheitlichen und statische Icon-Pfade aus public/icons ergänzen.
    const offers = filtered.map((o) => {
      const clearName = normalizeProviderDisplayName(o.package.clearName);
      const iconFile = PROVIDER_ICONS[clearName];
      const iconPath = iconFile ? `/icons/${iconFile}` : undefined;

      return {
        ...o,
        package: {
          clearName,
          ...(iconPath ? { iconPath } : {}),
        },
      };
    });

    cache.set(movieId, { offers, expiresAt: now + CACHE_TTL_MS });
    return offers;
  } catch {
    cache.set(movieId, { offers: [], expiresAt: now + CACHE_TTL_MS });
    return [];
  }
}
