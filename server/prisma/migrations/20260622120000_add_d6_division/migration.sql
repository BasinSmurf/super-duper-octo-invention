-- D6 FEX-services division. Field inspection (and shop work) are always D6;
-- only the Dickinson toggle splits the QB class (D6- FEX Services vs
-- Dickinson:Dickinson6 FEX). Additive enum value — safe to apply over data.
ALTER TYPE "ServiceDivision" ADD VALUE IF NOT EXISTS 'D6';
