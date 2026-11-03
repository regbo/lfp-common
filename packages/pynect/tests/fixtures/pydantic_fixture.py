from __future__ import annotations

from pydantic import BaseModel, field_validator


class User(BaseModel):
    id: int
    name: str

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        return value.upper()


def user_label(user: User) -> str:
    return f"{user.id}:{user.name}"


def make_user(user_id: int, name: str) -> User:
    return User(id=user_id, name=name)
