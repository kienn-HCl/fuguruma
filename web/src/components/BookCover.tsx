import { useState } from "react";
import { api, Book } from "../api";

const palette = ["#7c5e4b", "#4b6b7c", "#5e7c4b", "#7c4b6b", "#4b4f7c", "#7c6f4b", "#3f6f63", "#8a4f3d"];
function hash(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

export default function BookCover({ book }: { book: Book }) {
  const [failed, setFailed] = useState(false);
  const showImg = book.hasCover && !failed;
  return (
    <div className="cover">
      {showImg ? (
        <img src={api.coverUrl(book)} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <div className="fallback" style={{ background: palette[hash(book.title) % palette.length] }}>
          <span>{book.title}</span>
          <span className="a">{book.author}</span>
        </div>
      )}
      <span className="fmt">{book.format}</span>
    </div>
  );
}
