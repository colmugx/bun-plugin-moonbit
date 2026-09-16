pub(all) struct Point {
  x : Int
  y : Int
}

pub fn Point::Point(x : Int, y : Int) -> Point {
  { x, y }
}

pub fn double_x(p : Point) -> Int {
  p.x * 2
}
