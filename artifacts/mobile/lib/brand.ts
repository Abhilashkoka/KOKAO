import { useGetAppBrand, getGetAppBrandQueryKey } from "@workspace/api-client-react";

const domain = process.env.EXPO_PUBLIC_DOMAIN;

const DEFAULT_APP_NAME = "KOKAO";

function toAbsoluteUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  if (!domain) return null;
  return `https://${domain}${path}`;
}

export function useAppBrand() {
  const { data, isLoading } = useGetAppBrand({
    query: { queryKey: getGetAppBrandQueryKey(), staleTime: 5 * 60 * 1000 },
  });

  return {
    isLoading,
    appName: data?.appName || DEFAULT_APP_NAME,
    logoUrl: toAbsoluteUrl(data?.logoUrl),
    iconUrl: toAbsoluteUrl(data?.iconUrl),
  };
}
