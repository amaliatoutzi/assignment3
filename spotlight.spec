<concept_spec>
purpose
  recommend new museums to a user from their historical museum ratings, and produce a concise natural-language rationale for each recommendation

principle
  when a user has a history of museum ratings, the system asks an LLM to analyze those ratings  and to propose a ranked set of new museums with short rationales (e.g., “Similar contemporary sculpture focus to MoMA, which you loved”). As the user’s ratings change, future recommendations and rationales adapt.

state
a set of TasteSignals with
  a user User
  a museum Museum
  a taste of LOVE or LIKE or MEH
  an updatedAt DateTime

  a set of Recommendations with
    a user User
    a museum Museum
    a score Number                            // relative rank score from the LLM output (0..1)
    a rationale String                        // human-readable 1–2 sentence reason
    a generatedAt DateTime

actions
recordMuseumTaste (user: User, museum: Museum, taste: LOVE|LIKE|MEH)
    requires user exists
    effects upsert TasteSignals(user, museum) with taste; set updatedAt := now

clearMuseumTaste (user: User, museum: Museum)
    requires user and TasteSignals(user, museum) exist
    effects delete that TasteSignals

  llmRecommend (user: User, k: Number) : List<(museum: Museum, rationale: String)>
    requires k ≥ 1 and TasteSignals(user) not empty
    effect calls an LLM with a prompt containing:
           - the user’s MuseumRatings (LOVE/LIKE/MEH and optional avgStars)
           The LLM returns up to k museums not already rated by the user, each with a short rationale and a score.
           Replace Recommendations for (user) with the returned set; set generatedAt := now for each;

system
  refreshOnRatingChange (user: User)
    requires TasteSignals changed for user within a debounce window
    effects call llmRecommend(user, k := implementation default)

query
getRecommendations (user: User, k: Number) : List<(museum: Museum, rationale: String)>
  requires k ≥ 1
  effects return the top-k rows from Recommendations for user by score, most recent generatedAt; no LLM call

</concept_spec>
