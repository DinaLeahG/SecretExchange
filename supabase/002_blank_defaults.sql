-- Update for an existing database: party details start blank instead of pre-filled.
-- Safe to run on live data: it only changes defaults and clears values that
-- still match the old pre-filled text. Your people and draws are untouched.

alter table public.families alter column budget        set default '';
alter table public.families alter column occasion      set default '';
alter table public.families alter column signoff       set default '';
alter table public.families alter column email_subject set default '';

update public.families set budget = ''        where budget = '$10';
update public.families set occasion = ''      where occasion = 'Chanukah party';
update public.families set signoff = ''       where signoff = 'The Party Team';
update public.families set email_subject = '' where email_subject = '🤫 {name}''s Eyes Only: Your Secret Macabi Assignment Awaits!';
