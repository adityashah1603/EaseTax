# Errors found and how the design surfaced them

The packet loads with **65 open issues**: 54 come from our own checks (19 errors, 16 warnings, 19 info) and 11 are the engine's diagnostics. Each issue opens in the trace drawer, showing the line, the extracted value and the printed page side by side.

**The pattern:** the engine flags only 7 of these. Most of the costly errors carry **high confidence and no diagnostic**. They surface only through checks that don't trust the engine, which compare the extracted values with what the page prints, what the client said and what third parties recorded.

| # | Error | Effect | Caught by (issue id) |
|---|---|---|---|
| E1 | Theo's SSN is 3309 in the household record; the SS card says 3390 (this causes the e-file rejection) | Rejection | `id.ssn` · error |
| E2 | Northlake interest of 1,840 is counted twice | +1,840 income | `dup.cross_line` · error |
| E3 | The 1,099-K of 12,400 is already inside book revenue | +12,400 Sch C | `tp.gross_receipts_1099k` · error |
| E4 | Mileage includes a duplicate scan page (D23 p3) | −2,590 deduction | `dup.page` · error |
| E5 | SE health insurance of 14,400 while Erik was eligible for his spouse's plan | Should be 0 | `cvd.sehi_eligibility` · error |
| E6 | SEP contribution exceeds the limit by 2,786 (6% excise tax) | Excise | `recalc.sep_limit` · warning |
| E7 | Phone and internet at 100% (the call says 70% / 50%); Spotify is personal | −1,524 expenses | `cvd.call_business_use` · error |
| E8 | RSU lots N1, N3 and N4 at $0 basis; the supplemental statement gives 47,620 | Gain +47,620 | `sd.supplemental_basis` · error |
| E10 | Corrected 1099-B D31 replaces D30 | Handled | `dup.supersession` · info |
| E11 | Lot M18 is missing (detail 71,715 vs summary 71,965) | Missing loss | `sd.broker_lots` · error |
| E12 | Crypto lot C6 has $0 basis and is short-term; the client says about 3,050, long-term | Gain, character | `cvd.lot_basis_from_client` · warning |
| E13 | The questionnaire says no sales; there are 282 + 12 | Due diligence | `cvd.questionnaire_sales` · warning |
| E14 | Care provider EIN read as 74-3829**516**; the page prints **156** (read at confidence 0.97). The name is wrong too | Form 2441 | `read.printed`, `read.line_identity` · error |
| E15 | A heat pump of 11,000 expensed as a repair | +3,633 tax | `judgment.repair_vs_improvement` · warning |
| E16 | Rental insurance of 1,850 rests only on the questionnaire | No evidence | `comp.unsourced` · warning |
| E17 | Payoff interest of 2,150 is counted twice in mortgage interest | +2,150 deduction | `dup.within_line` · error |
| E18 | Property tax ignores the seller's 6,912 credit | SALT | `tp.seller_tax_credit` · error |
| E19 | Car donation claimed at 6,000; the 1098-C caps it at 2,900 (also in the 2028 notice) | +3,100 deduction | `tp.vehicle_donation_cap` · error |
| E20 | Federal estimates of 13,000; the IRS transcript shows 12,000 | Payments +1,000 | `tp.estimates_irs` · error |
| E21 | California estimates of 14,000; the FTB shows 10,500 | Payments +3,500 | `tp.estimates_ftb` · error |
| E22 | All wages sourced to California despite the July move | CA overstated | `state.ca_wages` · error |
| E23 | SEK interest converted at the 2024 rate | −124 income | `recalc.fx_year` · error |
| E24 | Client says no IRA basis; the 2024 Form 8606 shows 7,000 | Due diligence | `cvd.ira_basis` · warning |
| E25 | S corp opening basis rests only on the client's worksheet | Verify | `py.scorp_basis` · warning |
| E26 | Ridgeline outside basis never computed | Open item | `comp.basis_gap` · warning |
| E27 | Out-of-year forms D13, D40 and D42 | Must not feed 2025 | `comp.out_of_year` · info |
| E28 | FBAR, 1099-NECs and the 2023 Form 3520 are outstanding | Scope | `scope.fbar`, `scope.information_returns`, `scope.prior_open_items` · warning |
| E29 | Home office is 240 sq ft vs 300 last year | Explain | `py.area_change` · warning |
| E30 | Handwritten receipt read at confidence 0.41 | Verify | `read.low_confidence` · warning |
| E31 | California AMT not computed | Open item | `comp.not_computed` · warning |

**Not an error:** E9 (the ESPP basis is already adjusted). **Not raised as an issue:** Form 709 appears only as "consider" on the Completeness view, because the only gifts are charitable.

**Result:** 29 of the 30 real errors raise a work-queue issue on load, and the 30th (Form 709) is listed on the Completeness view.

**How the design closes them:**
- Correct the read or adjust the line, and the original is kept.
- A second person confirms closing any error.
- Sign-offs reopen if the numbers change.
- Filing is blocked while any error is open.
