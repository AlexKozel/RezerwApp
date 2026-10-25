-- Временный пароль сотрудника (D-061): owner задаёт его при приглашении или сбросе и знает его,
-- поэтому до смены пароля сотрудником кабинет ему закрыт (кроме входа, профиля и смены пароля).
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
