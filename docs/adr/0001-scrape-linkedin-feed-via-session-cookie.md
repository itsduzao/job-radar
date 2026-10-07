# Scrape do feed do LinkedIn via cookie de sessão e Playwright

Varremos posts do feed do LinkedIn pelo endpoint de busca de conteúdo (não pela API oficial), usando Playwright com um cookie de sessão `li_at` fornecido como secret do GitHub. A API oficial de Jobs exige parceria e o feed não tem API pública, então um cookie de sessão mantido é o único caminho gratuito; o custo é que o cookie expira a cada poucas semanas e o LinkedIn pode invalidá-lo ao detectar automação.

Consequência: a fonte é best-effort — o operador recoloca o cookie periodicamente e runs quebrados ocasionais são esperados, não um bug.
