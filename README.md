# Kupony Dnia

Strona z codziennymi kuponami piłkarskimi (~3, ~5, ~10, ~50). Co noc o 23:00 (czasu polskiego) GitHub Actions pobiera kursy z the-odds-api.com, układa kupony na następny dzień i zapisuje je w `data/`. Strona (GitHub Pages) tylko je wyświetla, więc **klucz API nigdy nie trafia do przeglądarki**, a automat działa, gdy Twój komputer jest wyłączony.

## Uruchomienie online (jednorazowo, ok. 10 minut)

1. Załóż konto na github.com i utwórz **publiczne** repozytorium (np. `kupony`). Publiczne jest potrzebne do darmowych GitHub Pages.
2. Wgraj do niego wszystkie pliki z tego folderu (z kropką: `.github/workflows/daily.yml`).
3. **Klucz API:** Settings → Secrets and variables → Actions → *New repository secret*. Nazwa: `ODDS_API_KEY`, wartość: klucz z the-odds-api.com.
4. **Strona:** Settings → Pages → Source: *Deploy from a branch* → branch `main`, folder `/ (root)`. Po chwili dostaniesz adres `https://TWOJA-NAZWA.github.io/kupony/`.
5. **Pierwszy test:** zakładka Actions → *Dzienne kupony* → *Run workflow*. Po minucie w repozytorium pojawi się folder `data/`, a strona pokaże kupony.

Dalej wszystko dzieje się samo, codziennie o 23:00.

## Ustawienia (`config.json`)

| Pole | Znaczenie | Domyślnie |
|---|---|---|
| `maxLeagues` | ile lig (najważniejszych, z meczami tego dnia) | 3 |
| `topMatches` | ile meczów w analizie | 8 |
| `extraMatches` | dla ilu najważniejszych meczów pobierać kartki i rożne | 2 |
| `minBooks` | min. liczba bukmacherów dla typu | 2 |

Koszt API: ok. 4 kredyty na ligę (główne rynki hurtem) + 2 na mecz z kartkami i rożnymi, czyli domyślnie ok. 16 dziennie (~480 miesięcznie, mieści się w darmowych 500). Zwiększenie któregoś pola podnosi koszt.

## Podgląd lokalny

Strona wymaga serwera HTTP (nie działa po dwukliku z dysku). Bez danych w `data/` pokaże przycisk „Pokaż podgląd demo".

## Uwagi

- Oznaczenia trafień (•/✓/✗) zapisują się w przeglądarce, na której je klikasz.
- Szanse to szacunki z kursów, nie gwarancja wyniku. 18+, graj odpowiedzialnie.
